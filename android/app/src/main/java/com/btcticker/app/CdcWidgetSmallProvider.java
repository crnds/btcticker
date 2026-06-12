package com.btcticker.app;

import android.app.AlarmManager;
import android.content.Context;
import android.widget.RemoteViews;

import java.util.List;

public class CdcWidgetSmallProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.CDC_WIDGET_SMALL_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.CDC_WIDGET_SMALL_MANUAL_REFRESH";

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return AlarmManager.INTERVAL_DAY; }
    @Override protected int    requestCodeBase()     { return 40; }

    @Override
    protected RemoteViews buildPlaceholder(Context ctx, boolean manual) {
        return label(ctx, manual ? "CDC · fetching…" : "CDC · –");
    }

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        List<KrakenCdc.Block> blocks = KrakenCdc.fetchOrCached(ctx, manual ? 0 : 60_000);
        if (blocks == null) return label(ctx, "CDC · failed");

        long updated = KrakenCdc.lastUpdate(ctx);
        RemoteViews v = label(ctx, "CDC · " + (updated > 0 ? timeAgo(updated) : "–"));
        v.setImageViewBitmap(R.id.widget_cdc_strip,
            KrakenCdc.renderStrip(ctx, blocks, 50, 36, 0f, 1f, 1f));
        return v;
    }

    private RemoteViews label(Context ctx, String text) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_cdc_small);
        v.setTextViewText(R.id.widget_cdc_label, text);
        v.setOnClickPendingIntent(R.id.widget_cdc_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }
}
