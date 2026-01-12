import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { checkRateLimit, logAttempt } from './rateLimit.js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CAPTCHA verification
async function verifyCaptcha(token, ip) {
  if (!token) return false;
  try {
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.CAPTCHA_SECRET_KEY}&response=${token}&remoteip=${ip}`
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('CAPTCHA ERROR:', err);
    return false;
  }
}

// Generate session token (AES-256-GCM)
function generateSessionToken() {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(process.env.SESSION_SECRET, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const uuid = uuidv4();
  const encrypted = cipher.update(uuid, 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { email, password, remember_me, captcha_token } = body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const ip = req.headers['x-forwarded-for'] || req.headers['client-ip'] || 'unknown';

    // Rate limiting
    if (!(await checkRateLimit(ip + email))) {
      return res.status(429).json({ success: false, error: 'Too many login attempts' });
    }

    // Verify CAPTCHA
    if (!(await verifyCaptcha(captcha_token, ip))) {
      await logAttempt(ip + email);
      return res.status(403).json({ success: false, error: 'CAPTCHA failed' });
    }

    // Fetch user from Supabase
    const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
    if (!user) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const passwordMatch = await bcrypt.compare(password, user.password || user.encrypted_password);
    if (!passwordMatch) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    // Create session
    const session_token = generateSessionToken();
    const expiresInDays = remember_me ? 90 : 1;

    await supabase.from('sessions').insert({
      user_email: email,
      session_token,
      expires_at: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    });

    // Set cookie
    res.setHeader(
      'Set-Cookie',
      `__Host-session_secure=${session_token}; Path=/; HttpOnly; Secure; Max-Age=${expiresInDays * 24 * 60 * 60}; SameSite=Strict`
    );

    return res.status(200).json({ success: true, message: 'Login successful!' });

  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
