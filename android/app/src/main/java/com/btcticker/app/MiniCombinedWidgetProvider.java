package com.btcticker.app;

import android.content.Context;
import android.widget.RemoteViews;

import java.util.List;

public class MiniCombinedWidgetProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.MINI_COMBINED_WIDGET_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.MINI_COMBINED_WIDGET_MANUAL_REFRESH";

    private static final long CDC_STALE_MS = 12 * 3600 * 1000L;

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return 10 * 60 * 1000L; }
    @Override protected int    requestCodeBase()     { return 60; }

    @Override
    protected RemoteViews buildPlaceholder(Context ctx, boolean manual) {
        if (manual) return null; // tap refresh updates in place, no wipe-flash
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_mini_combined);
        v.setTextViewText(R.id.widget_mini_price, "—");
        v.setTextViewText(R.id.widget_mini_change, "");
        v.setOnClickPendingIntent(R.id.widget_mini_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        BinanceApi.Ticker t = BinanceApi.fetchOrCached(ctx, manual ? 0 : 60_000);
        List<KrakenCdc.Block> blocks = KrakenCdc.fetchOrCached(ctx, CDC_STALE_MS);

        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_mini_combined);
        v.setTextViewText(R.id.widget_mini_price,  t.price);
        v.setTextViewText(R.id.widget_mini_change, t.change);
        v.setTextColor(R.id.widget_mini_change, t.changeVal >= 0 ? COLOR_UP : COLOR_DOWN);
        if (blocks != null) {
            v.setImageViewBitmap(R.id.widget_mini_strip,
                KrakenCdc.renderStrip(ctx, blocks, 50, 20, 0f, 1f, 1f));
        }
        if (t.updatedAt > 0) {
            v.setContentDescription(R.id.widget_mini_price,
                "BTC " + t.price + ", updated " + timeAgo(t.updatedAt));
        }
        v.setOnClickPendingIntent(R.id.widget_mini_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }
}
