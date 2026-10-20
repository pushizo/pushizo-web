import { renderWebCampaign } from './browser/web-campaign-render.js';

/** CDN girişi (ADR-0039): ana SDK web kampanyası göstereceği zaman bu paketi tembel yükler. */
(globalThis as unknown as { PushizoWebCampaignRender: { render: typeof renderWebCampaign } }).PushizoWebCampaignRender = { render: renderWebCampaign };
