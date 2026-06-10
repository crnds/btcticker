package com.btcticker.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
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

public class CdcWidgetSmallProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.CDC_WIDGET_SMALL_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.CDC_WIDGET_SMALL_MANUAL_REFRESH";

    private static final String PREFS         = "btc_cdc_widget";   // shared cache with 2×1 widget
    private static final long   INTERVAL_MS   = AlarmManager.INTERVAL_DAY;
    private static final String KRAKEN_URL    =
        "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440";
    private static final int    CANDLE_LIMIT  = 100;
    private static final int    DISPLAY_COUNT = 30;

    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    // ── AppWidgetProvider callbacks ──────────────────────────

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        scheduleAlarm(ctx);
        // Show a skeleton immediately so first placement (from widget picker) doesn't look blank
        for (int id : ids) {
            RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_cdc_small);
            v.setTextViewText(R.id.widget_cdc_label, "CDC · –");
            v.setOnClickPendingIntent(R.id.widget_cdc_refresh_btn, manualRefreshIntent(ctx));
            mgr.updateAppWidget(id, v);
        }
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
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, CdcWidgetSmallProvider.class));
        if (ids.length == 0) return;

        if (ACTION_MANUAL_REFRESH.equals(action)) {
            for (int id : ids) {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_cdc_small);
                v.setTextViewText(R.id.widget_cdc_label, "CDC · fetching…");
                v.setOnClickPendingIntent(R.id.widget_cdc_refresh_btn, manualRefreshIntent(ctx));
                mgr.updateAppWidget(id, v);
            }
        }
        fetchAndUpdate(ctx, mgr, ids);
    }

    // ── Fetch ────────────────────────────────────────────────

    private void fetchAndUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        Handler handler = new Handler(Looper.getMainLooper());
        executor.execute(() -> {
            List<CdcWidgetProvider.Block> fresh = null;
            try { fresh = fetchBlocks(ctx); } catch (Exception ignored) {}

            List<CdcWidgetProvider.Block> blocks = fresh != null ? fresh : loadCached(ctx);
            if (blocks == null) return;

            long updated = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                              .getLong("last_update", 0);
            Bitmap bmp = renderStrip(blocks, ctx);

            handler.post(() -> {
                RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_cdc_small);
                v.setImageViewBitmap(R.id.widget_cdc_strip, bmp);
                v.setTextViewText(R.id.widget_cdc_label,
                    "CDC · " + (updated > 0 ? PriceWidgetProvider.timeAgo(updated) : "–"));
                v.setOnClickPendingIntent(R.id.widget_cdc_refresh_btn, manualRefreshIntent(ctx));
                for (int id : ids) mgr.updateAppWidget(id, v);
            });
        });
    }

    // ── Kraken fetch + EMA calc ──────────────────────────────

    private List<CdcWidgetProvider.Block> fetchBlocks(Context ctx) throws Exception {
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
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
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

    private List<CdcWidgetProvider.Block> loadCached(Context ctx) {
        try {
            String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .getString("blocks", null);
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

    // ── Strip renderer — compact square, no gaps between bars ──

    private Bitmap renderStrip(List<CdcWidgetProvider.Block> blocks, Context ctx) {
        float density = ctx.getResources().getDisplayMetrics().density;

        // 50dp wide × 36dp tall — fills the square widget content area
        int W = Math.round(50 * density);
        int H = Math.round(36 * density);

        Bitmap bmp    = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint  paint  = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.FILL);

        int   n       = blocks.size();
        float slotW   = (float) W / n;  // no gaps — compact variant
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
            System.currentTimeMillis() + INTERVAL_MS, INTERVAL_MS, alarmIntent(ctx));
    }

    private void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    private PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, CdcWidgetSmallProvider.class);
        i.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(ctx, 40, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent manualRefreshIntent(Context ctx) {
        Intent i = new Intent(ctx, CdcWidgetSmallProvider.class);
        i.setAction(ACTION_MANUAL_REFRESH);
        return PendingIntent.getBroadcast(ctx, 41, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
