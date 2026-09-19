-- Records whether a decision was pushed to the real Luma API ('live') or only simulated
-- because no LUMA_API_KEY was configured ('simulated'). Kept separate from `status` so
-- simulated approvals still count toward venue capacity and budget caps.
alter table attendee_evaluations
  add column luma_sync_mode text check (luma_sync_mode in ('live', 'simulated'));
