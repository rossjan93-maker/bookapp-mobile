import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

export const hasSupabaseConfig = supabaseUrl.length > 0 && supabaseKey.length > 0;

export const supabase: SupabaseClient | null = hasSupabaseConfig
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        // Use AsyncStorage on native so sessions survive app restarts.
        // On web, leave undefined — Supabase defaults to localStorage.
        storage: Platform.OS !== 'web' ? AsyncStorage : undefined,
        autoRefreshToken: true,
        persistSession: true,
        // Native apps handle auth URLs via Linking, not window.location.
        detectSessionInUrl: false,
        // PKCE is the recommended flow for native apps — more secure than implicit.
        flowType: 'pkce',
      },
    })
  : null;
