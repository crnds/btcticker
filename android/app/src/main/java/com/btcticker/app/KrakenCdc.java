package com.btcticker.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * CDC Action Zone data: daily candles from Kraken → EMA12/26 cross blocks,
 * cached in shared prefs, rendered as a bull/bear bar-strip bitmap.
 */
final class KrakenCdc {

    static final String PREFS = "btc_cdc_widget";
    private static final String URL_OHLC =
        "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440";
    private static final int CANDLE_LIMIT  = 100;
    private static final int DISPLAY_COUNT = 30;

    static class Block {
        boolean bull;
        boolean today;
        double  diff;
    }

    private KrakenCdc() {}

    /**
     * Fetch fresh blocks unless the cache is younger than staleMs (0 = always
     * fetch); falls back to the cache on failure. Null only when both fail.
     */
    static List<Block> fetchOrCached(Context ctx, long staleMs) {
        if (staleMs > 0 && System.currentTimeMillis() - lastUpdate(ctx) <= staleMs) {
            List<Block> cached = loadCached(ctx);
            if (cached != null) return cached;
        }
        try {
            return fetch(ctx);
        } catch (Exception e) {
            Log.w(BaseWidgetProvider.TAG, "Kraken CDC fetch failed", e);
            return loadCached(ctx);
        }
    }

    static long lastUpdate(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong("last_update", 0);
    }

    private static List<Block> fetch(Context ctx) throws Exception {
        HttpURLConnection conn = null;
        String body;
        try {
            conn = (HttpURLConnection) new URL(URL_OHLC).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "btcticker-widget/1.0");
            body = Http.readBody(conn);
        } finally {
            if (conn != null) conn.disconnect();
        }

        JSONObject result = new JSONObject(body).getJSONObject("result");
        String pairKey = null;
        Iterator<String> keys = result.keys();
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
        // EMA26 warmup + display window; fewer candles would index out of bounds
        if (closes.length < DISPLAY_COUNT + 26) {
            throw new Exception("only " + closes.length + " candles");
        }

        double[] ema12 = calcEMA(closes, 12);
        double[] ema26 = calcEMA(closes, 26);
        int len = closes.length;

        List<Block> blocks = new ArrayList<>();
        for (int i = len - DISPLAY_COUNT; i < len; i++) {
            Block b = new Block();
            b.bull  = ema12[i] > ema26[i];
            b.today = (i == len - 1);
            b.diff  = Math.abs(ema12[i] - ema26[i]);
            blocks.add(b);
        }

        JSONArray arr = new JSONArray();
        for (Block b : blocks) {
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

    static List<Block> loadCached(Context ctx) {
        try {
            String raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .getString("blocks", null);
            if (raw == null) return null;
            JSONArray arr = new JSONArray(raw);
            List<Block> list = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Block b = new Block();
                b.bull  = o.getBoolean("bull");
                b.today = o.getBoolean("today");
                b.diff  = o.getDouble("diff");
                list.add(b);
            }
            return list;
        } catch (Exception e) { return null; }
    }

    /**
     * Render the strip. Dimensions in dp; bars grow up (bull) or down (bear)
     * from the vertical midline, height scaled by EMA distance, today's bar
     * at 40% opacity.
     */
    static Bitmap renderStrip(Context ctx, List<Block> blocks,
                              int widthDp, int heightDp, float gapDp,
                              float minBarDp, float cornerDp) {
        float density = ctx.getResources().getDisplayMetrics().density;
        int W = Math.round(widthDp * density);
        int H = Math.round(heightDp * density);

        Bitmap bmp    = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint  paint  = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setStyle(Paint.Style.FILL);

        int   n       = blocks.size();
        float gap     = gapDp * density;
        float slotW   = (W - gap * (n - 1)) / n;
        float midY    = H / 2f;
        float minBarH = minBarDp * density;
        float maxBarH = midY - density;
        float corner  = cornerDp * density;

        double minD = Double.MAX_VALUE, maxD = -Double.MAX_VALUE;
        for (Block b : blocks) {
            if (b.diff < minD) minD = b.diff;
            if (b.diff > maxD) maxD = b.diff;
        }
        double range = (maxD - minD) > 0 ? maxD - minD : 1;

        for (int i = 0; i < n; i++) {
            Block b    = blocks.get(i);
            float x    = i * (slotW + gap);
            float barH = minBarH + (float) ((b.diff - minD) / range) * (maxBarH - minBarH);
            int   base = b.bull ? BaseWidgetProvider.COLOR_UP : BaseWidgetProvider.COLOR_DOWN;
            paint.setColor((base & 0x00FFFFFF) | ((b.today ? 102 : 255) << 24));
            RectF r = b.bull
                ? new RectF(x, midY - barH, x + slotW, midY)
                : new RectF(x, midY, x + slotW, midY + barH);
            canvas.drawRoundRect(r, corner, corner, paint);
        }
        return bmp;
    }
}
