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
    // Extract visible text only (strip tags)
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

async function analyzeChange(url, oldContent, newContent) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are a competitive intelligence analyst. A competitor website changed.

URL: ${url}

BEFORE (excerpt):
${oldContent.substring(0, 1500)}

AFTER (excerpt):
${newContent.substring(0, 1500)}

Analyze what changed and what it means strategically. Respond in JSON only:
{
  "type": "price|product|content|hiring|other",
  "summary": "One sentence describing what changed",
  "insight": "One sentence strategic insight starting with 💡"
}`
        }]
      })
    });
    const data = await res.json();
    const text = data.content[0].text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('AI error:', e.message);
    return {
      type: 'content',
      summary: 'Page content changed',
      insight: '💡 Monitor this change closely for strategic implications.'
    };
  }
}

export default async function handler(req, res) {
  // Allow manual trigger via GET, or cron via any method
  if (req.method !== 'GET' && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('Scraper started at', new Date().toISOString());

  // Get all competitors
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
    const hasChanged = oldContent && oldContent !== newContent &&
      // Simple similarity check — if more than 5% different
      (Math.abs(oldContent.length - newContent.length) > 50 ||
       oldContent.substring(0, 500) !== newContent.substring(0, 500));

    // Update last_content
    await supabase
      .from('competitors')
      .update({ last_content: newContent, last_scanned: new Date().toISOString() })
      .eq('id', comp.id);

    if (hasChanged && oldContent) {
      console.log('Change detected for:', comp.url);
      const analysis = await analyzeChange(comp.url, oldContent, newContent);

      await supabase.from('changes').insert({
        competitor_id: comp.id,
        user_id: comp.user_id,
        type: analysis.type,
        summary: analysis.summary,
        insight: analysis.insight,
        detected_at: new Date().toISOString()
      });

      results.push({ url: comp.url, status: 'change_detected', analysis });
    } else {
      results.push({ url: comp.url, status: oldContent ? 'no_change' : 'first_scan' });
    }
  }

  console.log('Scraper done:', results);
  return res.json({ scanned: competitors.length, results });
}
