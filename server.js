const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize cache
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Middleware: Rate Limiter (10 req/15 min/IP, skip /health)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => req.path === '/health',
});

// CORS setup
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowed = [
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:5500',
        ];
        allowed.includes(origin) ? callback(null, true) : callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', apiLimiter);

// Utility: Get date string with offset
const getDateString = offset => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().split('T')[0];
};

// Utility: Fetch matches from API
async function fetchMatches(dateFrom = null, dateTo = null) {
    const API_TOKEN = process.env.FOOTBALL_API_TOKEN;
    if (!API_TOKEN) return { matches: [], count: 0, error: 'API token missing' };

    try {
        const fetch = (await import('node-fetch')).default;
        let url = 'https://api.football-data.org/v4/matches';
        const params = new URLSearchParams();

        if (dateFrom) {
            const fromDate = new Date(dateFrom);
            if (isNaN(fromDate)) throw new Error('Invalid dateFrom format');
            params.append('dateFrom', dateFrom);
        }

        if (dateFrom && !dateTo) {
            const to = new Date(dateFrom);
            to.setDate(to.getDate() + 5);
            dateTo = to.toISOString().split('T')[0];
        }

        if (dateTo) {
            const toDate = new Date(dateTo);
            if (isNaN(toDate)) throw new Error('Invalid dateTo format');
            params.append('dateTo', dateTo);
        }

        if (params.toString()) url += `?${params.toString()}`;

        const res = await fetch(url, {
            headers: {
                'X-Auth-Token': API_TOKEN,
                'User-Agent': 'Football-Matches-App/1.0'
            },
            timeout: 10000
        });

        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new Error(`API Error ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const matches = Array.isArray(data.matches) ? data.matches : [];
        const filtered = matches.filter(m => ['SCHEDULED', 'LIVE', 'IN_PLAY', 'PAUSED'].includes(m.status));
        return { matches: filtered, count: filtered.length, totalAvailable: matches.length };

    } catch (err) {
        return {
            matches: [],
            count: 0,
            error: err.message,
            timestamp: new Date().toISOString()
        };
    }
}

// Routes
app.get('/api/matches/today', async (req, res) => {
    const today = getDateString(0);
    const tomorrow = getDateString(1);
    const cacheKey = `matches_today_${today}`;

    const cached = cache.get(cacheKey);
    if (cached) {
        return res.json({ ...cached, cached: true, cacheTime: new Date().toISOString() });
    }

    const data = await fetchMatches(today, tomorrow);
    if (data.error) return res.status(503).json({ ...data, error: 'Service temporarily unavailable' });

    cache.set(cacheKey, data, 1800);
    res.json({ ...data, cached: false, fetchTime: new Date().toISOString() });
});

app.get('/api/matches/upcoming', async (req, res) => {
    const tomorrow = getDateString(1);
    const cacheKey = `matches_upcoming_from_${tomorrow}`;

    const cached = cache.get(cacheKey);
    if (cached) {
        return res.json({ ...cached, cached: true, cacheTime: new Date().toISOString() });
    }

    const data = await fetchMatches(tomorrow, null);
    if (data.error) return res.status(503).json({ ...data, error: 'Service temporarily unavailable' });

    cache.set(cacheKey, data, 300);
    res.json({ ...data, cached: false, fetchTime: new Date().toISOString() });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    fs.existsSync(indexPath)
        ? res.sendFile(indexPath)
        : res.status(404).json({ error: 'Frontend not found' });
});

// CORS error
app.use((err, req, res, next) => {
    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json({ error: 'CORS policy violation' });
    }
    next(err);
});

// API 404
app.use('/api/*', (req, res) => {
    res.status(404).json({
        error: 'API endpoint not found',
        availableEndpoints: [
            'GET /api/matches/today',
            'GET /api/matches/upcoming'
        ]
    });
});

// Generic 404
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found', message: `Cannot ${req.method} ${req.path}` });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    const isDev = process.env.NODE_ENV === 'development';
    res.status(err.status || 500).json({
        error: 'Internal server error',
        message: isDev ? err.message : 'Something went wrong',
        ...(isDev && { stack: err.stack })
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Today's Matches: /api/matches/today`);
    console.log(`📡 Upcoming Matches: /api/matches/upcoming`);

    if (!process.env.FOOTBALL_API_TOKEN) {
        console.log('⚠️ Missing FOOTBALL_API_TOKEN in .env');
    } else {
        console.log('✅ API token detected');
    }
});

// Server error handler
server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use`);
        process.exit(1);
    }
    console.error('❌ Server error:', err);
});

// Graceful shutdown
const shutdown = (signal) => {
    console.log(`\n📦 Received ${signal}, shutting down...`);
    server.close(err => {
        if (err) {
            console.error('❌ Shutdown error:', err);
            process.exit(1);
        }
        cache.flushAll();
        console.log('✅ Shutdown complete. Cache cleared.');
        process.exit(0);
    });

    setTimeout(() => {
        console.error('⏰ Force shutdown after timeout');
        process.exit(1);
    }, 10000);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
