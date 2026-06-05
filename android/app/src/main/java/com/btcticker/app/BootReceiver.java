package com.btcticker.app;

import android.appwidget.AppWidgetManager;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

/**
 * Reschedules widget alarms after device reboot — AlarmManager alarms are
 * cleared on reboot, so we re-trigger onUpdate for each active widget.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;

        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);

        int[] priceIds = mgr.getAppWidgetIds(
            new ComponentName(ctx, PriceWidgetProvider.class));
        if (priceIds.length > 0) {
            new PriceWidgetProvider().onUpdate(ctx, mgr, priceIds);
        }

        int[] cdcIds = mgr.getAppWidgetIds(
            new ComponentName(ctx, CdcWidgetProvider.class));
        if (cdcIds.length > 0) {
            new CdcWidgetProvider().onUpdate(ctx, mgr, cdcIds);
        }
    }
}
