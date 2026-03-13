const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

  // Travel / hospitality signals
  if (
    urlLower.match(/hotel|booking|airbnb|travel|flight|resort|hostel|villa|vacation|trip|tour/) ||
    contentLower.match(/book now|check availability|per night|per person|check-in|check-out|nights?|rooms?|guests?/)
  ) return 'travel';

  // E-commerce signals
  if (
    urlLower.match(/shop|store|buy|cart|product|ecommerce|commerce/) ||
    contentLower.match(/add to cart|buy now|in stock|out of stock|free shipping|\$[\d,.]+|price|discount|sale|off|checkout|order now/)
  ) return 'ecommerce';

  // SaaS signals
  if (
    urlLower.match(/app\.|dashboard|saas|software|platform|tool|cloud/) ||
    contentLower.match(/free trial|get started|pricing|per month|per year|\/mo|\/yr|sign up|upgrade|enterprise|starter|pro plan|business plan|features?|integrations?/)
  ) return 'saas';

  // Default
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
Focus on: room/package price changes, new destinations or properties, promotional offers, availability changes, policy updates (cancellation, check-in), loyalty program changes.
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

    if (!data.content || !data.content[0]) {
      throw new Error('No content in response: ' + JSON.stringify(data));
    }

    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in: ' + text);

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

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const forceMode = req.query.force === 'true';
  console.log('Scraper started at', new Date().toISOString(), forceMode ? '[FORCE MODE]' : '');

  const { data: competitors, error } = await supabase
    .from('competitors')
    .select('*');

  if (error) return res.status(500).json({ error: error.message });
  if (!competitors || competitors.length === 0) {
    return res.json({ message: 'No competitors to scan', scanned: 0 });
  }

  const results = [];

  for (const comp of competitors) {
    console.log('Scanning:', comp.url);

    const newContent = await fetchPage(comp.url);
    if (!newContent) {
      results.push({ url: comp.url, status: 'fetch_failed' });
      continue;
    }

    const oldContent = comp.last_content || '';
    const hasChanged = forceMode || (oldContent && oldContent !== newContent &&
      (Math.abs(oldContent.length - newContent.length) > 50 ||
       oldContent.substring(0, 500) !== newContent.substring(0, 500)));

    await supabase
      .from('competitors')
      .update({ last_content: newContent, last_scanned: new Date().toISOString() })
      .eq('id', comp.id);

    if (hasChanged && (oldContent || forceMode)) {
      console.log('Change detected for:', comp.url);
      const category = detectCategory(comp.url, newContent);
      console.log('Category detected:', category);
      const analysis = await analyzeChange(comp.url, oldContent, newContent, category);

      await supabase.from('changes').insert({
        competitor_id: comp.id,
        user_id: comp.user_id,
        type: analysis.type,
        summary: analysis.summary,
        insight: analysis.insight,
        detected_at: new Date().toISOString()
      });

      results.push({ url: comp.url, status: 'change_detected', category, analysis });
    } else {
      results.push({ url: comp.url, status: oldContent ? 'no_change' : 'first_scan' });
    }
  }

  console.log('Scraper done:', results);
  return res.json({ scanned: competitors.length, results });
};
