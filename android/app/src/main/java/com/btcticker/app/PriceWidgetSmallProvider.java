package com.btcticker.app;

import android.content.Context;
import android.widget.RemoteViews;

public class PriceWidgetSmallProvider extends BaseWidgetProvider {

    static final String ACTION_REFRESH        = "com.btcticker.app.PRICE_WIDGET_SMALL_REFRESH";
    static final String ACTION_MANUAL_REFRESH = "com.btcticker.app.PRICE_WIDGET_SMALL_MANUAL_REFRESH";

    @Override protected String actionRefresh()       { return ACTION_REFRESH; }
    @Override protected String actionManualRefresh() { return ACTION_MANUAL_REFRESH; }
    @Override protected long   intervalMs()          { return 10 * 60 * 1000L; }
    @Override protected int    requestCodeBase()     { return 30; }

    @Override
    protected RemoteViews buildUpdate(Context ctx, boolean manual) {
        BinanceApi.Ticker t = BinanceApi.fetchOrCached(ctx, manual ? 0 : 60_000);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_price_small);
        v.setTextViewText(R.id.widget_price,  t.price);
        v.setTextViewText(R.id.widget_change, t.change);
        v.setTextColor(R.id.widget_change, t.changeVal >= 0 ? COLOR_UP : COLOR_DOWN);
        // no room for a time label — expose the data age to accessibility instead
        if (t.updatedAt > 0) {
            v.setContentDescription(R.id.widget_price,
                "BTC " + t.price + ", updated " + timeAgo(t.updatedAt));
        }
        v.setOnClickPendingIntent(R.id.widget_refresh_btn, manualRefreshIntent(ctx));
        return v;
    }
}
