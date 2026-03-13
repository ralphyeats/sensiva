const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sensiva/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 5000);
  } catch (e) {
    console.error('Fetch error:', url, e.message);
    return null;
  }
}

function detectCategory(url, content) {
  const urlLower = url.toLowerCase();
  const contentLower = (content || '').toLowerCase();
  if (urlLower.match(/hotel|booking|airbnb|travel|flight|resort|hostel|villa|vacation|trip|tour/) ||
    contentLower.match(/book now|check availability|per night|per person|check-in|check-out|nights?|rooms?|guests?/))
    return 'travel';
  if (urlLower.match(/shop|store|buy|cart|product|ecommerce|commerce/) ||
    contentLower.match(/add to cart|buy now|in stock|out of stock|free shipping|\$[\d,.]+|price|discount|sale|off|checkout|order now/))
    return 'ecommerce';
  if (urlLower.match(/app\.|dashboard|saas|software|platform|tool|cloud/) ||
    contentLower.match(/free trial|get started|pricing|per month|per year|\/mo|\/yr|sign up|upgrade|enterprise|starter|pro plan|business plan|features?|integrations?/))
    return 'saas';
  return 'saas';
}

function buildPrompt(category, url, oldContent, newContent) {
  const base = `You are a competitive intelligence analyst. A competitor website changed.
URL: ${url}

BEFORE (excerpt):
${oldContent.substring(0, 1500)}

AFTER (excerpt):
${newContent.substring(0, 1500)}`;

  const instructions = {
    saas: `This is a SaaS or software product website.
Focus on: pricing plan changes, new/removed features, trial offer changes, enterprise tier updates, integration additions, positioning shifts, hiring signals.
Respond in JSON only:
{
  "type": "price|product|content|hiring|other",
  "summary": "One sentence describing what changed (be specific: mention exact prices, feature names, or plan names if visible)",
  "insight": "One sentence strategic insight starting with 💡 — what should the competitor do in response?"
}`,
    ecommerce: `This is an e-commerce or online retail website.
Focus on: product price changes, new collections or products, promotions/discounts, stock changes, shipping policy updates, homepage campaign shifts.
Respond in JSON only:
{
  "type": "price|product|content|hiring|other",
  "summary": "One sentence describing what changed (be specific: mention product names, prices, or discount percentages if visible)",
  "insight": "One sentence strategic insight starting with 💡 — what should a competing store do in response?"
}`,
    travel: `This is a travel, hotel, or hospitality booking website.
Focus on: room/package price changes, new destinations or properties, promotional offers, availability changes, policy updates, loyalty program changes.
Respond in JSON only:
{
  "type": "price|product|content|hiring|other",
  "summary": "One sentence describing what changed (be specific: mention destinations, prices, or offer names if visible)",
  "insight": "One sentence strategic insight starting with 💡 — what should a competing travel business do in response?"
}`
  };

  return `${base}\n\n${instructions[category] || instructions.saas}`;
}

async function analyzeChange(url, oldContent, newContent, category) {
  try {
    const prompt = buildPrompt(category, url, oldContent, newContent);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await res.json();
    if (!data.content || !data.content[0]) throw new Error('No content: ' + JSON.stringify(data));
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON: ' + text);
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('AI error:', e.message);
    return {
      type: 'content',
      summary: 'Page content changed — manual review recommended.',
      insight: '💡 Check the competitor site directly to understand what shifted.'
    };
  }
}

function typeLabel(type) {
  const labels = { price: '💰 Price Change', product: '🚀 New Product/Feature', hiring: '👥 Hiring Signal', content: '📝 Content Update', other: '🔔 Update' };
  return labels[type] || '🔔 Update';
}

function typeColor(type) {
  const colors = { price: '#f59e0b', product: '#10b981', hiring: '#6366f1', content: '#64748b', other: '#94a3b8' };
  return colors[type] || '#94a3b8';
}

async function sendEmailAlert(userEmail, competitorName, competitorUrl, analysis) {
  if (!RESEND_KEY) { console.log('No RESEND_API_KEY — skipping email'); return; }
  if (!userEmail) { console.log('No user email — skipping'); return; }

  const label = typeLabel(analysis.type);
  const color = typeColor(analysis.type);

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f0f14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f14;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="padding-bottom:28px;">
          <span style="font-family:'Arial Black',sans-serif;font-size:20px;font-weight:900;letter-spacing:2px;text-transform:uppercase;color:#b8f54a;">SENSIVA</span>
        </td></tr>

        <!-- Alert badge -->
        <tr><td style="padding-bottom:20px;">
          <span style="display:inline-block;background:${color}18;color:${color};border:1px solid ${color}40;border-radius:100px;padding:5px 14px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${label}</span>
        </td></tr>

        <!-- Competitor -->
        <tr><td style="padding-bottom:6px;">
          <span style="font-size:13px;color:#888;text-transform:uppercase;letter-spacing:1px;">Competitor</span>
        </td></tr>
        <tr><td style="padding-bottom:24px;">
          <span style="font-size:20px;font-weight:700;color:#eee8e0;">${competitorName}</span>
          <br><a href="${competitorUrl}" style="font-size:12px;color:#b8f54a;text-decoration:none;">${competitorUrl}</a>
        </td></tr>

        <!-- Change card -->
        <tr><td style="background:#16161e;border:1px solid #2a2a35;border-radius:14px;padding:24px;margin-bottom:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#888;margin-bottom:10px;">What changed</div>
          <div style="font-size:15px;color:#eee8e0;line-height:1.6;">${analysis.summary}</div>
        </td></tr>

        <tr><td style="padding:4px 0;"></td></tr>

        <!-- Insight card -->
        <tr><td style="background:#16161e;border:1px solid #2a2a35;border-left:3px solid #b8f54a;border-radius:14px;padding:24px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#b8f54a;margin-bottom:10px;">Strategic insight</div>
          <div style="font-size:15px;color:#eee8e0;line-height:1.6;">${analysis.insight}</div>
        </td></tr>

        <!-- CTA -->
        <tr><td style="padding:28px 0 8px;">
          <a href="https://sensiva-lime.vercel.app" style="display:inline-block;background:#b8f54a;color:#08080a;font-size:14px;font-weight:700;padding:14px 28px;border-radius:10px;text-decoration:none;letter-spacing:.3px;">View dashboard →</a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding-top:32px;border-top:1px solid #1e1e28;">
          <span style="font-size:12px;color:#555;">You're receiving this because you track ${competitorName} on Sensiva. <a href="https://sensiva-lime.vercel.app" style="color:#555;">Manage alerts</a></span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'Sensiva <alerts@sensiva.io>',
        to: [userEmail],
        subject: `⚡ ${competitorName} just changed — ${label}`,
        html
      })
    });
    const data = await res.json();
    console.log('Email sent:', data.id || JSON.stringify(data));
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const forceMode = req.query.force === 'true';
  console.log('Scraper started at', new Date().toISOString(), forceMode ? '[FORCE MODE]' : '');

  const { data: competitors, error } = await supabase.from('competitors').select('*');
  if (error) return res.status(500).json({ error: error.message });
  if (!competitors || competitors.length === 0) return res.json({ message: 'No competitors to scan', scanned: 0 });

  const results = [];

  for (const comp of competitors) {
    console.log('Scanning:', comp.url);
    const newContent = await fetchPage(comp.url);
    if (!newContent) { results.push({ url: comp.url, status: 'fetch_failed' }); continue; }

    const oldContent = comp.last_content || '';
    const hasChanged = forceMode || (oldContent && oldContent !== newContent &&
      (Math.abs(oldContent.length - newContent.length) > 50 ||
       oldContent.substring(0, 500) !== newContent.substring(0, 500)));

    await supabase.from('competitors').update({ last_content: newContent, last_scanned: new Date().toISOString() }).eq('id', comp.id);

    if (hasChanged && (oldContent || forceMode)) {
      console.log('Change detected for:', comp.url);
      const category = detectCategory(comp.url, newContent);
      const analysis = await analyzeChange(comp.url, oldContent, newContent, category);

      await supabase.from('changes').insert({
        competitor_id: comp.id,
        user_id: comp.user_id,
        type: analysis.type,
        summary: analysis.summary,
        insight: analysis.insight,
        detected_at: new Date().toISOString()
      });

      // Get user email and send alert
      const { data: userData } = await supabase.auth.admin.getUserById(comp.user_id);
      const userEmail = userData?.user?.email;
      await sendEmailAlert(userEmail, comp.name || comp.url, comp.url, analysis);

      results.push({ url: comp.url, status: 'change_detected', category, analysis, email_sent: !!userEmail });
    } else {
      results.push({ url: comp.url, status: oldContent ? 'no_change' : 'first_scan' });
    }
  }

  console.log('Scraper done:', results);
  return res.json({ scanned: competitors.length, results });
};
