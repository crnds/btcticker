package com.btcticker.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.RemoteViews;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Shared plumbing for all ticker widgets: repeating-alarm scheduling, refresh
 * routing, and background fetch execution. Refresh broadcasts are handled with
 * goAsync() so the process isn't killed mid-fetch when an alarm fires while
 * the app is dead.
 */
public abstract class BaseWidgetProvider extends AppWidgetProvider {

    static final String TAG = "btcticker.widget";

    static final int COLOR_UP   = 0xFF00e676;
    static final int COLOR_DOWN = 0xFFff1744;

    // One executor for every widget class: serialises all fetches and the
    // shared-prefs cache writes behind them
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    protected abstract String actionRefresh();
    protected abstract String actionManualRefresh();
    protected abstract long intervalMs();
    /** Alarm PendingIntent request code; manual refresh uses base + 1. */
    protected abstract int requestCodeBase();

    /**
     * Runs on the shared background executor. Do blocking fetch/render work
     * and return the views to post, or null to leave the widget unchanged.
     * manual=true means the user tapped refresh and expects fresh data;
     * scheduled updates may reuse a seconds-old cache to dedupe fetches
     * across widget families.
     */
    protected abstract RemoteViews buildUpdate(Context ctx, boolean manual);

    /**
     * Optional instant feedback posted before the background fetch.
     * manual=false → first-placement skeleton; manual=true → tap acknowledgement.
     */
    protected RemoteViews buildPlaceholder(Context ctx, boolean manual) { return null; }

    // ── AppWidgetProvider callbacks ──────────────────────────

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        scheduleAlarm(ctx);
        post(mgr, ids, buildPlaceholder(ctx, false));
        runUpdate(ctx, mgr, ids, goAsync(), false); // pr is null outside a broadcast (BootReceiver)
    }

    @Override public void onEnabled(Context ctx)  { scheduleAlarm(ctx); }
    @Override public void onDisabled(Context ctx) { cancelAlarm(ctx); }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        boolean manual = actionManualRefresh().equals(action);
        if (!manual && !actionRefresh().equals(action)) {
            super.onReceive(ctx, intent); // system actions → onUpdate/onEnabled/…
            return;
        }

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, getClass()));
        if (ids.length == 0) return;

        if (manual) post(mgr, ids, buildPlaceholder(ctx, true));
        runUpdate(ctx, mgr, ids, goAsync(), manual);
    }

    private void runUpdate(Context ctx, AppWidgetManager mgr, int[] ids,
                           PendingResult pr, boolean manual) {
        EXECUTOR.execute(() -> {
            try {
                post(mgr, ids, buildUpdate(ctx, manual));
            } catch (Exception e) {
                Log.w(TAG, getClass().getSimpleName() + " update failed", e);
            } finally {
                if (pr != null) pr.finish();
            }
        });
    }

    private static void post(AppWidgetManager mgr, int[] ids, RemoteViews v) {
        if (v == null) return;
        for (int id : ids) mgr.updateAppWidget(id, v);
    }

    // ── Alarm ────────────────────────────────────────────────

    private void scheduleAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setInexactRepeating(AlarmManager.RTC,
            System.currentTimeMillis() + intervalMs(), intervalMs(), alarmIntent(ctx));
    }

    private void cancelAlarm(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(ctx));
    }

    private PendingIntent alarmIntent(Context ctx) {
        Intent i = new Intent(ctx, getClass());
        i.setAction(actionRefresh());
        return PendingIntent.getBroadcast(ctx, requestCodeBase(), i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    protected PendingIntent manualRefreshIntent(Context ctx) {
        Intent i = new Intent(ctx, getClass());
        i.setAction(actionManualRefresh());
        return PendingIntent.getBroadcast(ctx, requestCodeBase() + 1, i,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ── Shared formatting ────────────────────────────────────

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
        String rel;
        if (secs < 60)        rel = secs + "s ago";
        else if (secs < 3600) rel = (secs / 60) + "m ago";
        else                  rel = (secs / 3600) + "h ago";

        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(ts);
        String hhmm = String.format("%02d:%02d",
            cal.get(java.util.Calendar.HOUR_OF_DAY),
            cal.get(java.util.Calendar.MINUTE));
        return "at " + hhmm + " (" + rel + ")";
    }
}
