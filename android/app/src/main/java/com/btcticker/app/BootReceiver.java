package com.btcticker.app;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Reschedules widget alarms after device reboot — AlarmManager alarms are
 * cleared on reboot, so we re-trigger onUpdate for each active widget.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);

        restart(ctx, mgr, PriceWidgetProvider.class);
        restart(ctx, mgr, CdcWidgetProvider.class);
        restart(ctx, mgr, PriceWidgetSmallProvider.class);
        restart(ctx, mgr, CdcWidgetSmallProvider.class);
        restart(ctx, mgr, CombinedWidgetProvider.class);
        restart(ctx, mgr, MiniCombinedWidgetProvider.class);
        restart(ctx, mgr, FearGreedWidgetProvider.class);
    }

    private static void restart(Context ctx, AppWidgetManager mgr,
                                 Class<? extends AppWidgetProvider> cls) {
        try {
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, cls));
            if (ids.length > 0) {
                Intent intent = new Intent(ctx, cls);
                intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
                ctx.sendBroadcast(intent);
            }
        } catch (Exception e) {
            Log.e("BootReceiver", "Failed to restart " + cls.getSimpleName(), e);
        }
    }
}
