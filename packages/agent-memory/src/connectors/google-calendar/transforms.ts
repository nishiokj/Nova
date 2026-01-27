/**
 * Google Calendar Transformations
 *
 * Transforms Google Calendar events into canonical Event entities.
 */

import { generateCanonicalId, sourceRefToKey } from '../../ids.js'
import type { Event } from '../../models/canonical.js'
import type { Transformation, TransformResult, TransformOutput } from '../../transform/types.js'
import {
  GoogleCalendarEventSchema,
  type GoogleCalendarEvent,
  type GoogleCalendarAttendee,
  type GoogleCalendarOrganizer,
} from './schemas.js'

// ============ Helper Functions ============

function createSourceRef(
  accountId: string,
  entityType: string,
  sourceId: string,
  sourceVersion?: string
): Event['source_refs'][0] {
  return {
    connector: 'google-calendar' as const,
    account_id: accountId,
    entity_type: entityType,
    source_id: sourceId,
    source_version: sourceVersion,
    last_synced_at: new Date().toISOString(),
  }
}

function createBaseEntity(id: string, sourceRef: Event['source_refs'][0]) {
  const now = new Date().toISOString()
  return {
    id,
    created_at: now,
    updated_at: now,
    source_refs: [sourceRef],
  }
}

function parseDateTime(dateTime: { date?: string; dateTime?: string; timeZone?: string } | undefined): {
  dateTime: string | null
  isAllDay: boolean
  timezone?: string
} {
  if (!dateTime) {
    return { dateTime: null, isAllDay: false }
  }

  if (dateTime.date) {
    // All-day event - convert YYYY-MM-DD to ISO datetime at start of day
    return {
      dateTime: new Date(dateTime.date).toISOString(),
      isAllDay: true,
    }
  }

  if (dateTime.dateTime) {
    return {
      dateTime: new Date(dateTime.dateTime).toISOString(),
      isAllDay: false,
      timezone: dateTime.timeZone,
    }
  }

  return { dateTime: null, isAllDay: false }
}

function extractEmail(organizer: GoogleCalendarOrganizer | undefined): string | undefined {
  return organizer?.email
}

function extractEmailFromAttendee(attendee: GoogleCalendarAttendee): string | undefined {
  return attendee.email
}

// ============ Transformations ============

export const googleCalendarEventTransform: Transformation<GoogleCalendarEvent> = {
  id: 'google-calendar:event:v1',
  name: 'Google Calendar Event → Canonical Event',
  source: {
    connector: 'google-calendar' as const,
    entityType: 'event',
  },
  inputSchema: GoogleCalendarEventSchema,
  outputType: 'event',
  transform(source, ctx): TransformResult {
    const sourceRef = createSourceRef(
      ctx.accountId,
      'event',
      source.id,
      source.updated // Use updated timestamp as version
    )

    // Parse start and end times
    const startParsed = parseDateTime(source.start)
    const endParsed = parseDateTime(source.end)

    // Store attendee/organizer emails in metadata since identity is not a valid entity type
    const attendeeEmails = new Set<string>()
    if (source.attendees) {
      for (const attendee of source.attendees) {
        const email = extractEmailFromAttendee(attendee)
        if (email) {
          attendeeEmails.add(email)
        }
      }
    }

    const organizerEmail = extractEmail(source.organizer)
    const creatorEmail = extractEmail(source.creator)

    const event: Event = {
      ...createBaseEntity(generateCanonicalId(), sourceRef),
      entity_type: 'event',
      title: source.summary || '(no title)',
      description: source.description,
      location: source.location,
      start_at: startParsed.dateTime || new Date().toISOString(),
      end_at: endParsed.dateTime || undefined,
      is_all_day: startParsed.isAllDay,
      timezone: startParsed.timezone || endParsed.timezone,
      organizer_identity_id: undefined,
      attendee_identity_ids: [],
      recurrence_rule: source.recurrence?.[0], // First recurrence rule as representative
      recurring_event_id: undefined, // Will set if this is an instance of a recurring event
      status: source.status || 'confirmed',
      metadata: {
        // Store participant info in metadata for now since identity is not a valid entity type
        organizer_email: organizerEmail,
        organizer_name: source.organizer?.displayName,
        creator_email: creatorEmail,
        creator_name: source.creator?.displayName,
        attendee_emails: Array.from(attendeeEmails),
        attendee_details: source.attendees,
        hangout_link: source.hangoutLink,
        conference_data: source.conferenceData,
      },
    }

    const primary: TransformOutput = {
      entityType: 'event',
      data: event,
      displayText: `${event.title} - ${startParsed.dateTime ? new Date(startParsed.dateTime).toLocaleDateString() : 'TBD'}`,
      sourceRefKey: sourceRefToKey(sourceRef),
    }

    return {
      primary,
    }
  },
  onError: 'quarantine',
  enabled: true,
  version: 1,
}

export const googleCalendarTransforms = [googleCalendarEventTransform]
