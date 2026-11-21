select cron.schedule(
  'cancha-post-match-details-daily',
  '30 7 * * *',
  $job$
    select net.http_post(
      url := 'https://ieqwkcznmbvewtavbpbn.supabase.co/functions/v1/sync-match-details',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'sync_function_secret' limit 1
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $job$
);
