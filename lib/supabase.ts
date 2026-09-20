import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const configurationError = new Error(
  'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.'
);

type QueryResult = {
  data: null;
  error: Error;
};

const createUnavailableQuery = () => {
  const query = (() => query) as (() => typeof query) & {
    then: (resolve: (result: QueryResult) => unknown) => Promise<unknown>;
  };

  query.then = (resolve) => Promise.resolve(resolve({ data: null, error: configurationError }));

  return new Proxy(query, {
    get(target, property) {
      if (property === 'then') return target.then;
      return () => target;
    },
  });
};

const createUnavailableClient = () => ({
  from: () => createUnavailableQuery(),
}) as unknown as SupabaseClient;

const createConfiguredClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) return null;

  try {
    return createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  } catch (error) {
    console.error('SUPABASE_CONFIG_ERROR: Invalid Supabase configuration.', error);
    return null;
  }
};

const configuredClient = createConfiguredClient();

export const supabase = configuredClient ?? createUnavailableClient();