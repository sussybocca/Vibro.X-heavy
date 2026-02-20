// pages/api/like-video.js (WITH REAL-TIME SUPPORT & COMMENT LIKES)
import { createClient } from '@supabase/supabase-js';
import cookie from 'cookie';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Verify session
    const cookies = cookie.parse(req.headers.cookie || '');
    const sessionToken = cookies['__Host-session_secure'] || cookies.session_secure;

    console.log('🔍 Like request - Session token found:', !!sessionToken);

    if (!sessionToken) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    // Get session with user_email
    const { data: session, error: sessionError } = await supabase
      .from('sessions')
      .select('user_email, expires_at')
      .eq('session_token', sessionToken)
      .maybeSingle();

    if (sessionError || !session) {
      console.error('Session error:', sessionError);
      return res.status(401).json({ success: false, error: 'Session expired or invalid' });
    }

    // Check if session is expired
    if (new Date(session.expires_at) < new Date()) {
      await supabase
        .from('sessions')
        .delete()
        .eq('session_token', sessionToken);
      return res.status(401).json({ success: false, error: 'Session expired' });
    }

    // Get user by email
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('email', session.user_email)
      .maybeSingle();

    if (userError || !user) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const userEmail = user.email;
    const userId = user.id;

    // Determine target type: video or comment
    const { videoId, commentId, action } = req.body; // action: 'like' or 'unlike'

    if (!action || (action !== 'like' && action !== 'unlike')) {
      return res.status(400).json({ success: false, error: 'Invalid action. Use "like" or "unlike"' });
    }

    let targetType, targetId, targetTable, ownerField, titleField;

    if (videoId) {
      targetType = 'video';
      targetId = videoId;
      targetTable = 'videos';
      ownerField = 'user_id';
      titleField = 'title';
    } else if (commentId) {
      targetType = 'comment';
      targetId = commentId;
      targetTable = 'comments';
      ownerField = 'user_id';
      titleField = 'content'; // or whatever your comment text field is
    } else {
      return res.status(400).json({ success: false, error: 'Missing videoId or commentId' });
    }

    console.log(`📝 Like request: ${targetType} ${targetId}, action: ${action}, user: ${userEmail}`);

    // Verify target exists and get owner info
    const { data: target, error: targetError } = await supabase
      .from(targetTable)
      .select(`id, ${ownerField}, ${titleField}`)
      .eq('id', targetId)
      .maybeSingle();

    if (targetError || !target) {
      console.error(`${targetType} error:`, targetError);
      return res.status(404).json({ success: false, error: `${targetType} not found` });
    }

    // Get owner details for notifications (if different from current user)
    const { data: targetOwner } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('id', target[ownerField])
      .maybeSingle();

    // Check if already liked
    const { data: existingLike, error: checkError } = await supabase
      .from('likes')
      .select('id')
      .eq('user_email', userEmail)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .maybeSingle();

    if (checkError) {
      console.error('Check like error:', checkError);
      return res.status(500).json({ success: false, error: 'Error checking like status' });
    }

    const alreadyLiked = !!existingLike;
    let successMessage = '';
    let updatedLikes = 0;

    // Handle like/unlike
    if (action === 'like') {
      if (alreadyLiked) {
        updatedLikes = await getLikeCount(targetType, targetId);
        return res.status(200).json({
          success: true,
          message: 'Already liked',
          likes: updatedLikes,
          liked: true,
          target_type: targetType,
          target_id: targetId,
          timestamp: Date.now()
        });
      }

      // Add like
      const { error: insertError } = await supabase
        .from('likes')
        .insert({
          user_email: userEmail,
          target_type: targetType,
          target_id: targetId,
          created_at: new Date().toISOString()
        });

      if (insertError) {
        console.error('Insert like error:', insertError);
        return res.status(500).json({ success: false, error: 'Failed to like' });
      }

      successMessage = `${targetType} liked successfully`;
      console.log(`✅ Like added: ${targetType} ${targetId} by ${userEmail}`);

      // Send notification to owner if not liking own content
      if (targetOwner && targetOwner.id !== userId) {
        try {
          let notificationPayload = {
            from_user_id: userId,
            from_user_email: userEmail,
            from_username: user.username,
            target_type: targetType,
            target_id: targetId,
            message: `${user.username || 'Someone'} liked your ${targetType}`
          };

          if (targetType === 'video') {
            notificationPayload.video_id = targetId;
            notificationPayload.video_title = target.title;
            notificationPayload.message = `${user.username || 'Someone'} liked your video "${target.title || 'your video'}"`;
          } else {
            notificationPayload.comment_id = targetId;
            notificationPayload.comment_preview = target.content?.substring(0, 50);
            notificationPayload.message = `${user.username || 'Someone'} liked your comment`;
          }

          await supabase
            .from('notifications')
            .insert({
              user_id: targetOwner.id,
              type: `${targetType}_like`,
              payload: notificationPayload,
              read: false,
              created_at: new Date().toISOString()
            });
          console.log(`📧 Notification sent to ${targetType} owner`);
        } catch (notifError) {
          console.error('Failed to send notification:', notifError);
          // Don't fail the whole request
        }
      }

    } else if (action === 'unlike') {
      if (!alreadyLiked) {
        updatedLikes = await getLikeCount(targetType, targetId);
        return res.status(200).json({
          success: true,
          message: 'Already not liked',
          likes: updatedLikes,
          liked: false,
          target_type: targetType,
          target_id: targetId,
          timestamp: Date.now()
        });
      }

      // Remove like
      const { error: deleteError } = await supabase
        .from('likes')
        .delete()
        .eq('user_email', userEmail)
        .eq('target_type', targetType)
        .eq('target_id', targetId);

      if (deleteError) {
        console.error('Delete like error:', deleteError);
        return res.status(500).json({ success: false, error: 'Failed to unlike' });
      }

      successMessage = `${targetType} unliked successfully`;
      console.log(`❌ Like removed: ${targetType} ${targetId} by ${userEmail}`);
    }

    // Get updated like count
    updatedLikes = await getLikeCount(targetType, targetId);

    // Update target table's like count (if you have a likes_count column) and timestamp for real-time detection
    try {
      await supabase
        .from(targetTable)
        .update({
          updated_at: new Date().toISOString(),
          likes_count: updatedLikes
        })
        .eq('id', targetId);

      console.log(`🔄 ${targetType} ${targetId} timestamp and likes_count updated`);
    } catch (updateError) {
      console.error(`Failed to update ${targetType}:`, updateError);
      // Continue anyway – the like is still recorded
    }

    console.log(`✅ Like operation completed successfully for ${targetType}`);

    return res.status(200).json({
      success: true,
      message: successMessage,
      likes: updatedLikes,
      liked: action === 'like',
      target_type: targetType,
      target_id: targetId,
      user_email: userEmail,
      timestamp: Date.now()
    });

  } catch (err) {
    console.error('💥 Like API error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
}

// Helper function to get like count for either video or comment
async function getLikeCount(targetType, targetId) {
  try {
    const { count, error } = await supabase
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('target_type', targetType)
      .eq('target_id', targetId);

    if (error) {
      console.error('Count error:', error);
      return 0;
    }

    return count || 0;
  } catch (err) {
    console.error('Error getting like count:', err);
    return 0;
  }
}
