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

public class PriceWidgetSmallProvider extends AppWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.PRICE_WIDGET_SMALL_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.PRICE_WIDGET_SMALL_MANUAL_REFRESH";

    private static final String PREFS       = "btc_price_widget";   // shared cache with 2×1 widget
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
    public void onEnabled(Context ctx) { scheduleAlarm(ctx); }

    @Override
    public void onDisabled(Context ctx) { cancelAlarm(ctx); }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent.getAction();
        if (!ACTION_REFRESH.equals(action) && !ACTION_MANUAL_REFRESH.equals(action)) return;

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, PriceWidgetSmallProvider.class));
        if (ids.length == 0) return;

        if (ACTION_MANUAL_REFRESH.equals(action)) {
            RemoteViews loading = buildViews(ctx, "—", "", 0f);
            for (int id : ids) mgr.updateAppWidget(id, loading);
        }
        fetchAndUpdate(ctx, mgr, ids);
    }

    // ── Fetch ────────────────────────────────────────────────

    private void fetchAndUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        Handler handler = new Handler(Looper.getMainLooper());
        executor.execute(() -> {
            String price   = null;
            String change  = null;
            float  changeF = 0f;

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

                price   = PriceWidgetProvider.fmtPrice(p);
                changeF = (float) c;
                change  = (c >= 0 ? "+" : "") + Math.round(c) + "%";

                ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString("price",     price)
                    .putString("change",    change)
                    .putFloat("change_val", changeF)
                    .putLong("last_update", System.currentTimeMillis())
                    .apply();

            } catch (Exception ignored) {}

            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String dp = price  != null ? price  : prefs.getString("price",  "—");
            String dc = change != null ? change : prefs.getString("change", "");
            float  df = price  != null ? changeF : prefs.getFloat("change_val", 0f);

            RemoteViews views = buildViews(ctx, dp, dc, df);
            handler.post(() -> {
                for (int id : ids) mgr.updateAppWidget(id, views);
            });
        });
    }

    // ── View builder ─────────────────────────────────────────

    private RemoteViews buildViews(Context ctx, String price, String change, float changeVal) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_price_small);
        v.setTextViewText(R.id.widget_price,  price);
        v.setTextViewText(R.id.widget_change, change);
        v.setTextColor(R.id.widget_change,
            changeVal >= 0 ? Color.parseColor("#00e676") : Color.parseColor("#ff1744"));
        v.setOnClickPendingIntent(R.id.widget_refresh_btn, manualRefreshIntent(ctx));
        return v;
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
        Intent i = new Intent(ctx, PriceWidgetSmallProvider.class);
        i.setAction(ACTION_REFRESH);
        return PendingIntent.getBroadcast(ctx, 30, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent manualRefreshIntent(Context ctx) {
        Intent i = new Intent(ctx, PriceWidgetSmallProvider.class);
        i.setAction(ACTION_MANUAL_REFRESH);
        return PendingIntent.getBroadcast(ctx, 31, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
