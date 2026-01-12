import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { checkRateLimit, logAttempt } from './rateLimit.js';

// Initialize Supabase
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY env variables!');
}
if (!process.env.SESSION_SECRET) {
  throw new Error('Missing SESSION_SECRET env variable!');
}
if (!process.env.CAPTCHA_SECRET_KEY) {
  console.error('Warning: CAPTCHA_SECRET_KEY missing!');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// CAPTCHA verification
async function verifyCaptcha(token, ip) {
  if (!token) return false;
  if (!process.env.CAPTCHA_SECRET_KEY) return false;

  try {
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${process.env.CAPTCHA_SECRET_KEY}&response=${token}&remoteip=${ip}`
    });
    const data = await res.json();
    return data?.success === true;
  } catch (err) {
    console.error('CAPTCHA ERROR:', err);
    return false;
  }
}

// AES-256-GCM encrypted session token
function generateSessionToken() {
  const iv = crypto.randomBytes(16); // 16 bytes IV
  const key = crypto.scryptSync(process.env.SESSION_SECRET, 'salt', 32); // 32 bytes key
  const uuid = uuidv4();

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const encrypted = cipher.update(uuid, 'utf8', 'hex') + cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

// ------------------- MAIN HANDLER -------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

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
    const captchaOk = await verifyCaptcha(captcha_token, ip);
    if (!captchaOk) {
      await logAttempt(ip + email);
      return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' });
    }

    // Fetch user from Supabase
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (userError) {
      console.error('Supabase fetch error:', userError);
      return res.status(500).json({ success: false, error: 'Database fetch failed' });
    }

    if (!user) {
      await logAttempt(ip + email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const storedPassword = user.password || user.encrypted_password || '';
    const passwordMatch = await bcrypt.compare(password, storedPassword);

    if (!passwordMatch) {
      await logAttempt(ip + email);
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    // Create AES-GCM session token
    const session_token = generateSessionToken();
    const expiresInDays = remember_me ? 90 : 1;

    const { error: sessionError } = await supabase.from('sessions').insert({
      user_email: email,
      session_token,
      expires_at: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    });

    if (sessionError) {
      console.error('Supabase session insert error:', sessionError);
      return res.status(500).json({ success: false, error: 'Failed to create session' });
    }

    // Set cookie securely
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
