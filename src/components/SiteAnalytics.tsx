"use client";

import { Analytics } from "@vercel/analytics/next";

// Page views only, with the query string dropped: /issue?h=… carries an owner's h,
// and no query value of this app belongs in a traffic report. Cookieless.
export function SiteAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => {
        const url = new URL(event.url);
        url.search = "";
        url.hash = "";
        return { ...event, url: url.toString() };
      }}
    />
  );
}
