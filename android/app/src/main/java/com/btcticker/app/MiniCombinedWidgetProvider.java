package com.btcticker.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MiniCombinedWidgetProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.MINI_COMBINED_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.MINI_COMBINED_WIDGET_MANUAL_REFRESH";

    private static final String BINANCE_URL  =
        "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT";
    private static final String KRAKEN_URL   =
        "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440";

    // Share caches with the other widgets
    private static final String PRICE_PREFS  = "btc_price_widget";
    private static final String CDC_PREFS    = "btc_cdc_widget";

    private static final long PRICE_INTERVAL = 10 * 60 * 1000L;
    private static final long CDC_STALE_MS   = 12 * 3600 * 1000L;
    private static final int  CANDLE_LIMIT   = 100;
    private static final int  DISPLAY_COUNT  = 30;

    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    // ── AppWidgetProvider callbacks ──────────────────────────

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        scheduleAlarm(ctx);
        fetchAndUpdate(ctx, mgr, ids);
    }

    @Override
    public void onEnabled(Context ctx) { scheduleAlarm(ctx); }

    @Override
    public void onDisabled(Context ctx) { cancelAlarm(ctx); }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent.getAction();
        if (!ACTION_REFRESH.equals(action) && !ACTION_MANUAL_REFRESH.equals(action)) return;

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, MiniCombinedWidgetProvider.class));
        if (ids.length == 0) return;

        if (ACTION_MANUAL_REFRESH.equals(action)) {
            for (int id : ids) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_mini_combined);
                v.setTextViewText(R.id.widget_mini_price, "…");
                v.setOnClickPendingIntent(R.id.widget_mini_refresh_btn, manualRefreshIntent(ctx));
                mgr.updateAppWidget(id, v);
            }
        }
        fetchAndUpdate(ctx, mgr, ids);
    }

    // ── Fetch both data sources, then update ─────────────────

    private void fetchAndUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        Handler handler = new Handler(Looper.getMainLooper());
        executor.execute(() -> {

            // ── 1. Price ──────────────────────────────────────
            String price   = null;
            String change  = null;
            float  changeF = 0f;
            try {
                HttpURLConnection conn =
                    (HttpURLConnection) new URL(BINANCE_URL).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setRequestProperty("Accept", "application/json");

                BufferedReader br =
                    new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                conn.disconnect();

                JSONObject json = new JSONObject(sb.toString());
                double p = Double.parseDouble(json.getString("lastPrice"));
                double c = Double.parseDouble(json.getString("priceChangePercent"));

                price   = PriceWidgetProvider.fmtPrice(p);
                changeF = (float) c;
                change  = (c >= 0 ? "+" : "") + Math.round(c) + "%";

                ctx.getSharedPreferences(PRICE_PREFS, Context.MODE_PRIVATE).edit()
                    .putString("price",     price)
                    .putString("change",    change)
                    .putFloat("change_val", changeF)
                    .putLong("last_update", System.currentTimeMillis())
                    .apply();
            } catch (Exception ignored) {}

            SharedPreferences pPrefs = ctx.getSharedPreferences(PRICE_PREFS, Context.MODE_PRIVATE);
            String dp = price  != null ? price  : pPrefs.getString("price",  "—");
            String dc = change != null ? change : pPrefs.getString("change", "");
            float  df = price  != null ? changeF : pPrefs.getFloat("change_val", 0f);

            // ── 2. CDC — refresh only when cache is stale ──────
            SharedPreferences cPrefs = ctx.getSharedPreferences(CDC_PREFS, Context.MODE_PRIVATE);
            long cdcLastUpdate = cPrefs.getLong("last_update", 0);
            boolean cdcStale   = System.currentTimeMillis() - cdcLastUpdate > CDC_STALE_MS;

            List<CdcWidgetProvider.Block> blocks = null;
            if (cdcStale) {
                try { blocks = fetchBlocks(ctx, cPrefs); } catch (Exception ignored) {}
            }
            if (blocks == null) blocks = loadCachedBlocks(cPrefs);

            Bitmap strip = blocks != null ? renderStrip(blocks, ctx) : null;

            final String fPrice = dp; final String fChange = dc; final float fChgF = df;
            final Bitmap fStrip = strip;

            handler.post(() -> {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_mini_combined);
                v.setTextViewText(R.id.widget_mini_price,  fPrice);
                v.setTextViewText(R.id.widget_mini_change, fChange);
                v.setTextColor(R.id.widget_mini_change,
                    fChgF >= 0 ? Color.parseColor("#00e676") : Color.parseColor("#ff1744"));
                if (fStrip != null) v.setImageViewBitmap(R.id.widget_mini_strip, fStrip);
                v.setOnClickPendingIntent(R.id.widget_mini_refresh_btn, manualRefreshIntent(ctx));
                for (int id : ids) mgr.updateAppWidget(id, v);
            });
        });
    }

    // ── Kraken fetch + EMA calc ──────────────────────────────

    private List<CdcWidgetProvider.Block> fetchBlocks(Context ctx, SharedPreferences cPrefs)
            throws Exception {
        HttpURLConnection conn =
            (HttpURLConnection) new URL(KRAKEN_URL).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        conn.setRequestProperty("User-Agent", "btcticker-widget/1.0");

        BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream()));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = br.readLine()) != null) sb.append(line);
        br.close();
        conn.disconnect();

        JSONObject json   = new JSONObject(sb.toString());
        JSONObject result = json.getJSONObject("result");

        String pairKey = null;
        java.util.Iterator<String> keys = result.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            if (!"last".equals(k)) { pairKey = k; break; }
        }
        if (pairKey == null) throw new Exception("no pair key");

        JSONArray candles = result.getJSONArray(pairKey);
        int total = candles.length();
        int from  = Math.max(0, total - CANDLE_LIMIT);
        double[] closes = new double[total - from];
        for (int i = from; i < total; i++) {
            closes[i - from] = Double.parseDouble(candles.getJSONArray(i).getString(4));
        }

        double[] ema12 = calcEMA(closes, 12);
        double[] ema26 = calcEMA(closes, 26);
        int len = closes.length;

        List<CdcWidgetProvider.Block> blocks = new ArrayList<>();
        for (int i = len - DISPLAY_COUNT; i < len; i++) {
            CdcWidgetProvider.Block b = new CdcWidgetProvider.Block();
            b.bull  = ema12[i] > ema26[i];
            b.today = (i == len - 1);
            b.diff  = Math.abs(ema12[i] - ema26[i]);
            blocks.add(b);
        }

        JSONArray arr = new JSONArray();
        for (CdcWidgetProvider.Block b : blocks) {
            JSONObject o = new JSONObject();
            o.put("bull",  b.bull);
            o.put("today", b.today);
            o.put("diff",  b.diff);
            arr.put(o);
        }
        cPrefs.edit()
            .putString("blocks",    arr.toString())
            .putLong("last_update", System.currentTimeMillis())
            .apply();

        return blocks;
    }

    private static double[] calcEMA(double[] closes, int period) {
        double   k   = 2.0 / (period + 1);
        double[] out = new double[closes.length];
        double   sum = 0;
        for (int i = 0; i < period; i++) sum += closes[i];
        out[period - 1] = sum / period;
        for (int i = period; i < closes.length; i++) {
            out[i] = closes[i] * k + out[i - 1] * (1 - k);
        }
        return out;
    }

    private List<CdcWidgetProvider.Block> loadCachedBlocks(SharedPreferences prefs) {
        try {
            String raw = prefs.getString("blocks", null);
            if (raw == null) return null;
            JSONArray arr = new JSONArray(raw);
            List<CdcWidgetProvider.Block> list = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                CdcWidgetProvider.Block b = new CdcWidgetProvider.Block();
                b.bull  = o.getBoolean("bull");
                b.today = o.getBoolean("today");
                b.diff  = o.getDouble("diff");
                list.add(b);
            }
            return list;
        } catch (Exception e) { return null; }
    }

    // ── Strip bitmap renderer for bottom half ────────────────

    private Bitmap renderStrip(List<CdcWidgetProvider.Block> blocks, Context ctx) {
        float density = ctx.getResources().getDisplayMetrics().density;

        // Bottom half of a 1×1 widget: ~48dp wide, ~20dp tall
        int W = Math.round(50 * density);
        int H = Math.round(20 * density);

        Bitmap bmp    = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint  paint  = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.FILL);

        int   n       = blocks.size();
        float slotW   = (float) W / n;
        float midY    = H / 2f;
        float minBarH = 1 * density;
        float maxBarH = midY - density;

        double minD = Double.MAX_VALUE, maxD = -Double.MAX_VALUE;
        for (CdcWidgetProvider.Block b : blocks) {
            if (b.diff < minD) minD = b.diff;
            if (b.diff > maxD) maxD = b.diff;
        }
        double range = (maxD - minD) > 0 ? maxD - minD : 1;

        for (int i = 0; i < n; i++) {
            CdcWidgetProvider.Block b = blocks.get(i);
            float x    = i * slotW;
            float barH = minBarH + (float)((b.diff - minD) / range) * (maxBarH - minBarH);
            int   alpha = b.today ? 102 : 255;

            if (b.bull) {
                paint.setColor(Color.argb(alpha, 0x00, 0xe6, 0x76));
                canvas.drawRoundRect(
                    new RectF(x, midY - barH, x + slotW, midY),
                    1 * density, 1 * density, paint);
            } else {
                paint.setColor(Color.argb(alpha, 0xff, 0x17, 0x44));
                canvas.drawRoundRect(
                    new RectF(x, midY, x + slotW, midY + barH),
                    1 * density, 1 * density, paint);
            }
        }

        return bmp;
    }

    // ── Alarm ────────────────────────────────────────────────

    private void scheduleAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setInexactRepeating(AlarmManager.RTC,
            System.currentTimeMillis() + PRICE_INTERVAL, PRICE_INTERVAL, alarmIntent(ctx));
    }

    private void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    private PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, MiniCombinedWidgetProvider.class);
        i.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(ctx, 60, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent manualRefreshIntent(Context ctx) {
        Intent i = new Intent(ctx, MiniCombinedWidgetProvider.class);
        i.setAction(ACTION_MANUAL_REFRESH);
        return PendingIntent.getBroadcast(ctx, 61, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
