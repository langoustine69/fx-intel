import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync } from 'fs';

const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';

const agent = await createAgent({
  name: 'fx-intel',
  version: '1.0.0',
  description: 'Real-time FX/currency intelligence - live rates, conversions, historical data, volatility analysis. ECB-sourced data for financial agents.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON ===
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// === Serve icon ===
app.get('/icon.png', async (c) => {
  try {
    const icon = readFileSync('./icon.png');
    return new Response(icon, {
      headers: { 'Content-Type': 'image/png' }
    });
  } catch {
    return c.text('Icon not found', 404);
  }
});

// === ERC-8004 Registration ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://fx-intel-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "fx-intel",
    description: "Real-time FX/currency intelligence - live rates, conversions, historical data, volatility analysis. ECB-sourced data for financial agents. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free FX overview - supported currencies and sample rates (try before you buy)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [currencies, latest] = await Promise.all([
      fetchJSON(`${FRANKFURTER_BASE}/currencies`),
      fetchJSON(`${FRANKFURTER_BASE}/latest?base=USD`)
    ]);
    
    return { 
      output: { 
        source: 'European Central Bank (ECB)',
        currencyCount: Object.keys(currencies).length,
        supportedCurrencies: currencies,
        sampleRates: {
          base: latest.base,
          date: latest.date,
          rates: {
            EUR: latest.rates.EUR,
            GBP: latest.rates.GBP,
            JPY: latest.rates.JPY,
            CHF: latest.rates.CHF
          }
        },
        fetchedAt: new Date().toISOString()
      } 
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Convert amount ===
addEntrypoint({
  key: 'convert',
  description: 'Convert amount between currencies (live ECB rates)',
  input: z.object({ 
    from: z.string().length(3).describe('Source currency code (e.g., USD)'),
    to: z.string().length(3).describe('Target currency code (e.g., EUR)'),
    amount: z.number().positive().describe('Amount to convert')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const { from, to, amount } = ctx.input;
    const data = await fetchJSON(
      `${FRANKFURTER_BASE}/latest?base=${from.toUpperCase()}&symbols=${to.toUpperCase()}`
    );
    
    const rate = data.rates[to.toUpperCase()];
    const converted = amount * rate;
    
    return { 
      output: { 
        from: from.toUpperCase(),
        to: to.toUpperCase(),
        amount,
        rate,
        converted: Math.round(converted * 100) / 100,
        date: data.date,
        source: 'ECB'
      } 
    };
  },
});

// === PAID ENDPOINT 2 ($0.002): Get rates for base currency ===
addEntrypoint({
  key: 'rates',
  description: 'Get current exchange rates for a base currency',
  input: z.object({ 
    base: z.string().length(3).default('USD').describe('Base currency code'),
    symbols: z.string().optional().describe('Comma-separated target currencies (e.g., EUR,GBP,JPY)')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { base, symbols } = ctx.input;
    let url = `${FRANKFURTER_BASE}/latest?base=${base.toUpperCase()}`;
    if (symbols) {
      url += `&symbols=${symbols.toUpperCase()}`;
    }
    
    const data = await fetchJSON(url);
    
    return { 
      output: { 
        base: data.base,
        date: data.date,
        rates: data.rates,
        rateCount: Object.keys(data.rates).length,
        source: 'ECB'
      } 
    };
  },
});

// === PAID ENDPOINT 3 ($0.002): Historical rates ===
addEntrypoint({
  key: 'historical',
  description: 'Get historical exchange rate for a specific date',
  input: z.object({ 
    date: z.string().describe('Date in YYYY-MM-DD format'),
    base: z.string().length(3).default('USD').describe('Base currency'),
    symbols: z.string().optional().describe('Comma-separated currencies')
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { date, base, symbols } = ctx.input;
    let url = `${FRANKFURTER_BASE}/${date}?base=${base.toUpperCase()}`;
    if (symbols) {
      url += `&symbols=${symbols.toUpperCase()}`;
    }
    
    const data = await fetchJSON(url);
    
    return { 
      output: { 
        base: data.base,
        date: data.date,
        rates: data.rates,
        source: 'ECB'
      } 
    };
  },
});

// === PAID ENDPOINT 4 ($0.003): Timeseries data ===
addEntrypoint({
  key: 'timeseries',
  description: 'Get historical rates over a date range (for volatility/trend analysis)',
  input: z.object({ 
    startDate: z.string().describe('Start date (YYYY-MM-DD)'),
    endDate: z.string().describe('End date (YYYY-MM-DD)'),
    base: z.string().length(3).default('USD').describe('Base currency'),
    symbols: z.string().describe('Comma-separated currencies (e.g., EUR,GBP)')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const { startDate, endDate, base, symbols } = ctx.input;
    const url = `${FRANKFURTER_BASE}/${startDate}..${endDate}?base=${base.toUpperCase()}&symbols=${symbols.toUpperCase()}`;
    
    const data = await fetchJSON(url);
    
    // Calculate basic stats
    const symbolList = symbols.toUpperCase().split(',');
    const stats: Record<string, { min: number; max: number; avg: number; change: number }> = {};
    
    for (const sym of symbolList) {
      const values = Object.values(data.rates).map((r: any) => r[sym]).filter(Boolean);
      if (values.length > 0) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const first = values[0];
        const last = values[values.length - 1];
        const change = ((last - first) / first) * 100;
        
        stats[sym] = {
          min: Math.round(min * 10000) / 10000,
          max: Math.round(max * 10000) / 10000,
          avg: Math.round(avg * 10000) / 10000,
          change: Math.round(change * 100) / 100
        };
      }
    }
    
    return { 
      output: { 
        base: data.base,
        startDate: data.start_date,
        endDate: data.end_date,
        dataPoints: Object.keys(data.rates).length,
        stats,
        rates: data.rates,
        source: 'ECB'
      } 
    };
  },
});

// === PAID ENDPOINT 5 ($0.005): Full FX report ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive FX report - current rates, 30-day trends, volatility for major pairs',
  input: z.object({ 
    base: z.string().length(3).default('USD').describe('Base currency')
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const { base } = ctx.input;
    
    // Get today's date and 30 days ago
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const endDate = today.toISOString().split('T')[0];
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    
    const majorPairs = 'EUR,GBP,JPY,CHF,AUD,CAD';
    
    const [currencies, latest, timeseries] = await Promise.all([
      fetchJSON(`${FRANKFURTER_BASE}/currencies`),
      fetchJSON(`${FRANKFURTER_BASE}/latest?base=${base.toUpperCase()}`),
      fetchJSON(`${FRANKFURTER_BASE}/${startDate}..${endDate}?base=${base.toUpperCase()}&symbols=${majorPairs}`)
    ]);
    
    // Calculate 30-day stats for each major pair
    const analysis: Record<string, {
      current: number;
      min30d: number;
      max30d: number;
      avg30d: number;
      change30d: number;
      volatility: number;
    }> = {};
    
    for (const sym of majorPairs.split(',')) {
      const values = Object.values(timeseries.rates).map((r: any) => r[sym]).filter(Boolean);
      if (values.length > 0) {
        const min = Math.min(...values);
        const max = Math.max(...values);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const first = values[0];
        const last = values[values.length - 1];
        const change = ((last - first) / first) * 100;
        const volatility = ((max - min) / avg) * 100;
        
        analysis[sym] = {
          current: Math.round(latest.rates[sym] * 10000) / 10000,
          min30d: Math.round(min * 10000) / 10000,
          max30d: Math.round(max * 10000) / 10000,
          avg30d: Math.round(avg * 10000) / 10000,
          change30d: Math.round(change * 100) / 100,
          volatility: Math.round(volatility * 100) / 100
        };
      }
    }
    
    return { 
      output: { 
        base: base.toUpperCase(),
        reportDate: latest.date,
        source: 'European Central Bank (ECB)',
        availableCurrencies: Object.keys(currencies).length,
        currentRates: latest.rates,
        analysis30Day: analysis,
        period: { start: startDate, end: endDate },
        generatedAt: new Date().toISOString()
      } 
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  price: { amount: 0 },
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🪙 FX Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
