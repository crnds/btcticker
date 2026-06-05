package com.btcticker.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.widget.RemoteViews;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class PriceWidgetProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.PRICE_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.PRICE_WIDGET_MANUAL_REFRESH";

    private static final String PREFS       = "btc_price_widget";
    private static final long   INTERVAL_MS = 10 * 60 * 1000L;
    private static final String API_URL     =
        "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT";

    private static final ExecutorService executor = Executors.newSingleThreadExecutor();

    // ── AppWidgetProvider callbacks ──────────────────────────

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        scheduleAlarm(ctx);
        fetchAndUpdate(ctx, mgr, ids);
    }

    @Override
    public void onEnabled(Context ctx) {
        scheduleAlarm(ctx);
    }

    @Override
    public void onDisabled(Context ctx) {
        cancelAlarm(ctx);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent.getAction();
        if (!ACTION_REFRESH.equals(action) && !ACTION_MANUAL_REFRESH.equals(action)) return;

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PriceWidgetProvider.class));
        if (ids.length == 0) return;

        if (ACTION_MANUAL_REFRESH.equals(action)) {
            // Flash the label to confirm tap
            RemoteViews loading = buildViews(ctx, "—", "", 0f, 0);
            loading.setTextViewText(R.id.widget_time, "fetching…");
            for (int id : ids) mgr.updateAppWidget(id, loading);
        }
        fetchAndUpdate(ctx, mgr, ids);
    }

    // ── Fetch ────────────────────────────────────────────────

    private void fetchAndUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        Handler handler = new Handler(Looper.getMainLooper());
        executor.execute(() -> {
            String price    = null;
            String change   = null;
            float  changeF  = 0f;
            long   fetchedAt = 0;

            try {
                HttpURLConnection conn =
                    (HttpURLConnection) new URL(API_URL).openConnection();
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

                price    = fmtPrice(p);
                changeF  = (float) c;
                change   = (c >= 0 ? "+" : "") + Math.round(c) + "%";
                fetchedAt = System.currentTimeMillis();

                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("price",      price)
                    .putString("change",     change)
                    .putFloat("change_val",  changeF)
                    .putLong("last_update",  fetchedAt)
                    .apply();

            } catch (Exception ignored) {}

            // Fall back to cache if fetch failed
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String displayPrice  = price    != null ? price    : prefs.getString("price",     "—");
            String displayChange = change   != null ? change   : prefs.getString("change",    "");
            float  displayChgF   = price    != null ? changeF  : prefs.getFloat("change_val", 0f);
            long   displayAt     = fetchedAt != 0   ? fetchedAt : prefs.getLong("last_update", 0);

            RemoteViews views = buildViews(ctx, displayPrice, displayChange, displayChgF, displayAt);
            handler.post(() -> {
                for (int id : ids) mgr.updateAppWidget(id, views);
            });
        });
    }

    // ── View builder ─────────────────────────────────────────

    private RemoteViews buildViews(Context ctx,
                                   String price, String change,
                                   float changeVal, long lastUpdate) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_price);
        v.setTextViewText(R.id.widget_price,  price);
        v.setTextViewText(R.id.widget_change, change);
        v.setTextColor(R.id.widget_change,
            changeVal >= 0 ? Color.parseColor("#00e676") : Color.parseColor("#ff1744"));
        v.setTextViewText(R.id.widget_time,
            lastUpdate > 0 ? timeAgo(lastUpdate) : "");
        v.setOnClickPendingIntent(R.id.widget_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }

    // ── Alarm ────────────────────────────────────────────────

    private void scheduleAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setInexactRepeating(
            AlarmManager.RTC,
            System.currentTimeMillis() + INTERVAL_MS,
            INTERVAL_MS,
            alarmIntent(ctx));
    }

    private void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    private PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, PriceWidgetProvider.class);
        i.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(ctx, 10, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent manualRefreshIntent(Context ctx) {
        Intent i = new Intent(ctx, PriceWidgetProvider.class);
        i.setAction(ACTION_MANUAL_REFRESH);
        return PendingIntent.getBroadcast(ctx, 11, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── Helpers ──────────────────────────────────────────────

    static String fmtPrice(double p) {
        long rounded = Math.round(p);
        String s = Long.toString(rounded);
        StringBuilder out = new StringBuilder();
        int mod = s.length() % 3;
        for (int i = 0; i < s.length(); i++) {
            if (i > 0 && (i - mod) % 3 == 0) out.append(',');
            out.append(s.charAt(i));
        }
        return out.toString();
    }

    static String timeAgo(long ts) {
        long secs = (System.currentTimeMillis() - ts) / 1000;
        if (secs < 60)   return secs + "s ago";
        if (secs < 3600) return (secs / 60) + "m ago";
        return (secs / 3600) + "h ago";
    }
}
