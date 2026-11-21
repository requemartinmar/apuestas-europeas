select cron.schedule(
  'cancha-as-lineups-daily',
  '0 8 * * *',
  $$
    select net.http_post(
      url := 'https://ieqwkcznmbvewtavbpbn.supabase.co/functions/v1/sync-as-lineups',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'sync_function_secret'
          limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $$
);
