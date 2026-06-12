package com.btcticker.app;

import android.app.AlarmManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.util.Log;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;

public class FearGreedWidgetProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.FG_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.FG_WIDGET_MANUAL_REFRESH";

    private static final String PREFS = "btc_feargreed_widget";
    // alternative.me serves the same index keyless; never embed an API key here —
    // anything in the APK is world-readable
    private static final String API_URL = "https://api.alternative.me/fng/?limit=1";

    // 5 arc segments left→right: Extreme Fear, Fear, Neutral, Greed, Extreme Greed
    private static final int[] SEG_COLORS = {
        0xFFff1744, 0xFFff6d00, 0xFFffeb3b, 0xFF69f0ae, 0xFF00e676
    };

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return AlarmManager.INTERVAL_DAY; }
    @Override protected int    requestCodeBase()     { return 70; }

    // ── Fetch ────────────────────────────────────────────────

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        int    value          = -1;
        String classification = null;
        long   fetchedAt      = 0;

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(API_URL).openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("Accept", "application/json");

            JSONObject data = new JSONObject(Http.readBody(conn))
                .getJSONArray("data").getJSONObject(0);
            value          = data.getInt("value");
            classification = data.getString("value_classification");
            fetchedAt      = System.currentTimeMillis();

            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("value",        value)
                .putString("label",     classification)
                .putLong("last_update", fetchedAt)
                .apply();
        } catch (Exception e) {
            Log.w(TAG, "Fear & Greed fetch failed", e);
        } finally {
            if (conn != null) conn.disconnect();
        }

        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int    dv = value          != -1   ? value          : prefs.getInt("value",       -1);
        String dl = classification != null ? classification : prefs.getString("label",   "");
        long   da = fetchedAt      != 0    ? fetchedAt      : prefs.getLong("last_update", 0);

        Bitmap bmp = renderGauge(dv, dl != null ? dl : "", da, ctx);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_feargreed);
        v.setImageViewBitmap(R.id.widget_fg_gauge, bmp);
        v.setOnClickPendingIntent(R.id.widget_fg_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }

    // ── Gauge bitmap renderer ────────────────────────────────

    private Bitmap renderGauge(int value, String label, long lastUpdate, Context ctx) {
        float dp = ctx.getResources().getDisplayMetrics().density;

        int W = Math.round(210 * dp);
        int H = Math.round(78  * dp);

        Bitmap bmp    = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        Paint  paint  = new Paint(Paint.ANTI_ALIAS_FLAG);

        // Arc — center at 80% down so the top clears the title row
        float arcR   = 32f * dp;
        float stroke = 7f  * dp;
        float cx     = W   * 0.5f;
        float cy     = H   * 0.80f;

        RectF oval = new RectF(cx - arcR, cy - arcR, cx + arcR, cy + arcR);

        // 5 segments × 34° sweep, 2.5° gap between each
        // Slots: i × 36.5° starting at 180° → total 4×36.5+34 = 180° ✓
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(stroke);
        paint.setStrokeCap(Paint.Cap.BUTT);
        for (int i = 0; i < 5; i++) {
            paint.setColor(SEG_COLORS[i]);
            canvas.drawArc(oval, 180f + i * 36.5f, 34f, false, paint);
        }

        // White dot indicator at arc position for current value
        if (value >= 0) {
            double rad  = Math.toRadians(180.0 + (value / 100.0) * 180.0);
            float  dotX = cx + arcR * (float) Math.cos(rad);
            float  dotY = cy + arcR * (float) Math.sin(rad);

            paint.setStyle(Paint.Style.FILL);
            paint.setColor(0xFF0d0d0d);        // dark halo for contrast
            canvas.drawCircle(dotX, dotY, 5.5f * dp, paint);
            paint.setColor(0xFFFFFFFF);
            canvas.drawCircle(dotX, dotY, 4f * dp, paint);
        }

        // Title "Fear & Greed"
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(0xFFFFFFFF);
        paint.setTypeface(Typeface.DEFAULT_BOLD);
        paint.setTextSize(10f * dp);
        canvas.drawText("Fear & Greed", 10f * dp, 13f * dp, paint);

        // Value number — coloured by range
        paint.setColor(value >= 0 ? colorForValue(value) : 0xFF94a3b8);
        paint.setTextSize(22f * dp);
        String valStr = value >= 0 ? String.valueOf(value) : "—";
        float  valW   = paint.measureText(valStr);
        canvas.drawText(valStr, cx - valW / 2f, cy - 3f * dp, paint);

        // Classification label
        paint.setColor(0xFF94a3b8);
        paint.setTextSize(8f * dp);
        paint.setTypeface(Typeface.DEFAULT);
        float lblW = paint.measureText(label);
        canvas.drawText(label, cx - lblW / 2f, cy + 10f * dp, paint);

        // Fetch time — bottom-right, very small
        if (lastUpdate > 0) {
            String time = timeAgo(lastUpdate);
            paint.setColor(0xFF64748b);
            paint.setTextSize(6f * dp);
            float timeW = paint.measureText(time);
            canvas.drawText(time, W - timeW - 8f * dp, H - 4f * dp, paint);
        }

        return bmp;
    }

    private static int colorForValue(int value) {
        // same quintile bands as the arc, so a Neutral 50 reads yellow, not green
        return SEG_COLORS[Math.min(value / 20, 4)];
    }
}
