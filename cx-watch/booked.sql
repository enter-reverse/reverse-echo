-- Bookings in Mindbody for the next 7 days, newest state of each appointment (hourly copy + live webhooks), with the
-- client's name and mobile. Used by the CX updates to mark a flagged booking "✅ booked, no action" (the user, 22 Nov
-- 8:05pm: "check mindbody that it is booked so we know no need our action"). Webhook times are true UTC.
with wh as (
  select distinct on (payload->'eventData'->>'appointmentId') payload->'eventData'->>'appointmentId' id,
         payload->'eventData'->>'staffId' staff, payload->'eventData'->>'clientId' client,
         ((payload->'eventData'->>'startDateTime')::timestamptz at time zone 'Asia/Singapore') st,
         case when payload->>'eventId' = 'appointmentBooking.cancelled' then 'Cancelled'
              else coalesce(payload->'eventData'->>'status', 'Scheduled') end status, received_at
  from raw.mindbody_webhook_events
  where payload->>'eventId' like 'appointmentBooking.%' and payload->'eventData'->>'siteId' = '5750520'
    and (payload->'eventData'->>'startDateTime')::timestamptz between now() - interval '2 hours' and now() + interval '7 days'
  order by payload->'eventData'->>'appointmentId', received_at desc),
ap as (
  select distinct on (payload->>'Id') payload->>'Id' id, payload->>'StaffId' staff, payload->>'ClientId' client,
         (payload->>'StartDateTime')::timestamp st, payload->>'Status' status, received_at
  from raw.mindbody_appointments
  where (payload->>'StartDateTime')::timestamp between (now() at time zone 'Asia/Singapore') - interval '2 hours'
        and (now() at time zone 'Asia/Singapore') + interval '7 days'
  order by payload->>'Id', received_at desc),
m as (
  select coalesce(w.id, a.id) id,
         case when w.id is not null and (a.id is null or w.received_at > a.received_at) then w.staff else a.staff end staff,
         case when w.id is not null and (a.id is null or w.received_at > a.received_at) then w.client else a.client end client,
         case when w.id is not null and (a.id is null or w.received_at > a.received_at) then w.st else a.st end st,
         case when w.id is not null and (a.id is null or w.received_at > a.received_at) then w.status else a.status end status
  from ap a full join wh w on w.id = a.id)
select to_char(st, 'Dy DD Mon HH24:MI') at_sgt,
       case staff when '100000003' then 'Contrast 1' when '100000007' then 'Contrast 2' when '100000008' then 'HBOT'
                  when '100000009' then 'Red Light' when '100000011' then 'Dry Float' else staff end room,
       status,
       (select concat_ws(' ', c.payload->>'FirstName', c.payload->>'LastName', '·', c.payload->>'MobilePhone')
          from raw.mindbody_clients c where c.payload->>'Id' = m.client or c.payload->>'UniqueId' = m.client
          order by c.received_at desc limit 1) client
from m where status not in ('Cancelled', 'LateCancelled') and st is not null
order by st;