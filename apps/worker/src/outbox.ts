import nodemailer from "nodemailer";
import { config } from "./config";
import { pool } from "./db";
import { fanOutScheduleChange } from "./schedule-notify";

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined
});

type EmailPayload = { to: string; subject: string; text: string; html: string };
type ScheduleChangedPayload = {
  featureId: string;
  version: number;
  changedBy: string;
  timezone: string;
  upcomingClosures: Array<{
    id: string;
    localDate: string;
    endLocalDate: string | null;
    allDay: boolean;
    startTime: string | null;
    reason: string;
  }>;
};

type OutboxEvent = {
  id: string;
  kind: string;
  payload: EmailPayload | ScheduleChangedPayload;
  attempts: number;
};

export async function recoverStuckOutbox(): Promise<void> {
  await pool.query(
    `UPDATE outbox_events
     SET status = 'pending', available_at = now(), last_error = 'Recovered after worker timeout', updated_at = now()
     WHERE status = 'processing' AND updated_at < now() - interval '10 minutes'`
  );
}

export async function dispatchOutbox(eventId?: string): Promise<void> {
  const result = await pool.query<OutboxEvent>(
    `WITH claimed AS (
       SELECT id FROM outbox_events
       WHERE status = 'pending'
         AND available_at <= now()
         AND ($1::uuid IS NULL OR id = $1::uuid)
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 20
     )
     UPDATE outbox_events o
     SET status = 'processing', updated_at = now()
     FROM claimed
     WHERE o.id = claimed.id
     RETURNING o.id, o.kind, o.event_type, o.payload, o.attempts`,
    [eventId ?? null]
  );

  for (const event of result.rows) {
    try {
      if (event.kind === "schedule_changed") {
        await fanOutScheduleChange(event.id, event.payload as ScheduleChangedPayload);
      } else {
        const payload = event.payload as EmailPayload;
        await transporter.sendMail({
          from: config.MAIL_FROM,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
          html: payload.html
        });
      }
      await pool.query(
        `UPDATE outbox_events
         SET status = 'processed', processed_at = now(), last_error = NULL, updated_at = now()
         WHERE id = $1`,
        [event.id]
      );
    } catch (error) {
      const attempts = event.attempts + 1;
      const failed = attempts >= 5;
      await pool.query(
        `UPDATE outbox_events
         SET status = $2,
             attempts = $3,
             available_at = now() + ($4::text || ' seconds')::interval,
             last_error = $5,
             updated_at = now()
         WHERE id = $1`,
        [
          event.id,
          failed ? "failed" : "pending",
          attempts,
          String(Math.min(300, 2 ** attempts)),
          error instanceof Error ? error.message.slice(0, 1000) : "Unknown event error"
        ]
      );
    }
  }
}
