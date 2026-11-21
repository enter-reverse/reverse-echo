-- Free slots at Joo Chiat, from Mindbody bookings in Olympus (hourly copy + live webhooks).
-- Replace :DAY with a date 'YYYY-MM-DD'. Open every day 7am to 10pm (content/prices.ts).
-- Rooms are Mindbody "staff": Contrast Room 1 and 2, the HBOT chamber, Red Light, Dry Float.
-- A start is free when nothing booked in that room overlaps [start - buffer, start + length + buffer).
with params as (select ':DAY'::date d),
base as (
  select distinct on (payload->>'Id') (payload->>'Id')::bigint id, (payload->>'StaffId')::bigint staff,
         (payload->>'StartDateTime')::timestamp st, (payload->>'EndDateTime')::timestamp et,
         payload->>'Status' status, received_at
  from raw.mindbody_appointments, params
  where (payload->>'StartDateTime')::date between d - 1 and d + 1
  order by payload->>'Id', received_at desc),
wh as (
  select distinct on (payload->'eventData'->>'appointmentId') (payload->'eventData'->>'appointmentId')::bigint id,
         (payload->'eventData'->>'staffId')::bigint staff,
         ((payload->'eventData'->>'startDateTime')::timestamptz at time zone 'Asia/Singapore') st,
         ((payload->'eventData'->>'endDateTime')::timestamptz at time zone 'Asia/Singapore') et,
         case when payload->>'eventId' = 'appointmentBooking.cancelled' then 'Cancelled'
              else coalesce(payload->'eventData'->>'status', 'Scheduled') end status, received_at
  from raw.mindbody_webhook_events, params
  where payload->>'eventId' like 'appointmentBooking.%'
    and ((payload->'eventData'->>'startDateTime')::timestamptz at time zone 'Asia/Singapore')::date between d - 1 and d + 1
  order by payload->'eventData'->>'appointmentId', received_at desc),
merged as (
  select coalesce(w.id, b.id) id,
         case when w.id is not null and (b.id is null or w.received_at > b.received_at) then w.staff else b.staff end staff,
         case when w.id is not null and (b.id is null or w.received_at > b.received_at) then w.st else b.st end st,
         case when w.id is not null and (b.id is null or w.received_at > b.received_at) then w.et else b.et end et,
         case when w.id is not null and (b.id is null or w.received_at > b.received_at) then w.status else b.status end status
  from base b full join wh w on w.id = b.id),
busy as (select * from merged where status not in ('Cancelled', 'LateCancelled') and st is not null),
rooms(staff, therapy, mins, buf, last_start) as (values
  (100000003, 'Contrast', 75, 15, time '20:30'), (100000007, 'Contrast', 75, 15, time '20:30'),
  (100000008, 'HBOT 55', 55, 5, time '21:00'), (100000008, 'HBOT 100', 100, 5, time '20:00'),
  (100000009, 'Red Light', 20, 10, time '21:30'), (100000011, 'Dry Float', 50, 10, time '21:00')),
starts as (
  select r.*, s from rooms r, params p,
       generate_series(p.d + time '07:00', p.d + r.last_start, interval '30 min') s
  where s > (now() at time zone 'Asia/Singapore')),
free as (
  select therapy, s, count(*) rooms_free from starts x
  where not exists (select 1 from busy b where b.staff = x.staff
                    and b.st < x.s + make_interval(mins => x.mins + x.buf) and b.et > x.s - make_interval(mins => x.buf))
  group by therapy, s)
select therapy, string_agg(to_char(s, 'HH24:MI') || case when therapy = 'Contrast' and rooms_free > 1 then '(x2)' else '' end, ' ' order by s) free_starts
from free group by therapy order by therapy;
