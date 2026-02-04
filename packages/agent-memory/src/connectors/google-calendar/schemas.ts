/**
 * Google Calendar API Response Schemas
 *
 * Zod schemas for validating Google Calendar API v3 responses.
 * Based on Google Calendar REST API v3.
 *
 * @module connectors/google-calendar/schemas
 */

import { z } from 'zod'

// ============ Event ============

/**
 * Google Calendar event reminder.
 */
export const GoogleCalendarReminderSchema = z.object({
  method: z.enum(['email', 'popup', 'sms', 'alert']),
  minutes: z.number(),
})

export type GoogleCalendarReminder = z.infer<typeof GoogleCalendarReminderSchema>

/**
 * Google Calendar event attendee.
 */
export const GoogleCalendarAttendeeSchema = z.object({
  id: z.string().optional(),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  responseStatus: z.enum(['needsAction', 'declined', 'tentative', 'accepted']).optional(),
  comment: z.string().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
  additionalGuests: z.number().optional(),
})

export type GoogleCalendarAttendee = z.infer<typeof GoogleCalendarAttendeeSchema>

/**
 * Google Calendar event organizer.
 */
export const GoogleCalendarOrganizerSchema = z.object({
  id: z.string().optional(),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  self: z.boolean().optional(),
})

export type GoogleCalendarOrganizer = z.infer<typeof GoogleCalendarOrganizerSchema>

/**
 * Google Calendar event date/time.
 */
export const GoogleCalendarDateTimeSchema = z.object({
  date: z.string().optional(), // Date in YYYY-MM-DD format for all-day events
  dateTime: z.string().optional(), // RFC3339 timestamp for timed events
  timeZone: z.string().optional(),
})

export type GoogleCalendarDateTime = z.infer<typeof GoogleCalendarDateTimeSchema>

/**
 * Google Calendar event extended property.
 */
export const GoogleCalendarExtendedPropertySchema = z.object({
  private: z.record(z.string(), z.string()).optional(),
  shared: z.record(z.string(), z.string()).optional(),
})

export type GoogleCalendarExtendedProperty = z.infer<typeof GoogleCalendarExtendedPropertySchema>

/**
 * Google Calendar conference solution data.
 */
export const GoogleCalendarConferenceDataSchema = z.object({
  createRequest: z.object({
    requestId: z.string(),
    conferenceSolutionKey: z.object({
      type: z.string(),
    }),
    status: z.object({
      statusCode: z.string(),
    }).optional(),
  }).optional(),
  entryPoints: z.array(z.object({
    entryPointType: z.enum(['video', 'phone', 'sip', 'more']),
    uri: z.string().optional(),
    label: z.string().optional(),
    pin: z.string().optional(),
    accessCode: z.string().optional(),
    meetingCode: z.string().optional(),
    password: z.string().optional(),
  })).optional(),
  conferenceSolution: z.object({
    key: z.object({
      type: z.string(),
    }),
    name: z.string(),
    iconUri: z.string().optional(),
  }).optional(),
})

export type GoogleCalendarConferenceData = z.infer<typeof GoogleCalendarConferenceDataSchema>

/**
 * Google Calendar event.
 */
export const GoogleCalendarEventSchema = z.object({
  id: z.string(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  htmlLink: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  colorId: z.string().optional(),
  creator: GoogleCalendarOrganizerSchema.optional(),
  organizer: GoogleCalendarOrganizerSchema.optional(),
  start: GoogleCalendarDateTimeSchema,
  end: GoogleCalendarDateTimeSchema,
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: GoogleCalendarDateTimeSchema.optional(),
  transparency: z.enum(['opaque', 'transparent']).optional(),
  visibility: z.enum(['default', 'public', 'private', 'confidential']).optional(),
  iCalUID: z.string().optional(),
  sequence: z.number().optional(),
  attendees: z.array(GoogleCalendarAttendeeSchema).optional(),
  attendeesOmitted: z.boolean().optional(),
  extendedProperties: GoogleCalendarExtendedPropertySchema.optional(),
  hangoutLink: z.string().optional(),
  conferenceData: GoogleCalendarConferenceDataSchema.optional(),
  gadget: z.object({
    type: z.string(),
    title: z.string().optional(),
    link: z.string().optional(),
    iconLink: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    display: z.enum(['icon', 'chip']).optional(),
    preferences: z.record(z.string(), z.string()).optional(),
  }).optional(),
  anyoneCanAddSelf: z.boolean().optional(),
  guestsCanInviteOthers: z.boolean().optional(),
  guestsCanModify: z.boolean().optional(),
  guestsCanSeeOtherGuests: z.boolean().optional(),
  privateCopy: z.boolean().optional(),
  locked: z.boolean().optional(),
  reminders: z.object({
    useDefault: z.boolean(),
    overrides: z.array(GoogleCalendarReminderSchema).optional(),
  }).optional(),
  source: z.object({
    url: z.string(),
    title: z.string().optional(),
  }).optional(),
  workingLocationProperties: z.object({
    type: z.enum(['homeOffice', 'customLocation', 'officeLocation']),
    customLocation: z.object({
      label: z.string(),
  }).optional(),
    officeLocation: z.object({
      buildingId: z.string(),
      deskId: z.string(),
      floorId: z.string(),
    }).optional(),
  }).optional(),
})

export type GoogleCalendarEvent = z.infer<typeof GoogleCalendarEventSchema>

// ============ Event List ============

/**
 * Google Calendar events list response.
 */
export const GoogleCalendarEventListSchema = z.object({
  kind: z.literal('calendar#events'),
  etag: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  updated: z.string().optional(),
  timeZone: z.string().optional(),
  accessRole: z.enum([
    'freeBusyReader', 'owner', 'reader', 'writer',
    'none', 'editor', 'organizer', 'projector'
  ]).optional(),
  defaultReminders: z.array(GoogleCalendarReminderSchema).optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  items: z.array(GoogleCalendarEventSchema),
})

export type GoogleCalendarEventList = z.infer<typeof GoogleCalendarEventListSchema>

// ============ Calendar List ============

/**
 * Google Calendar entry.
 */
export const GoogleCalendarEntrySchema = z.object({
  kind: z.literal('calendar#calendarListEntry'),
  etag: z.string(),
  id: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  location: z.string().optional(),
  timeZone: z.string().optional(),
  summaryOverride: z.string().optional(),
  colorId: z.string().optional(),
  backgroundColor: z.string().optional(),
  foregroundColor: z.string().optional(),
  hidden: z.boolean().optional(),
  selected: z.boolean().optional(),
  accessRole: z.enum([
    'freeBusyReader', 'owner', 'reader', 'writer',
    'none', 'editor', 'organizer', 'projector'
  ]).optional(),
  primary: z.boolean().optional(),
  deleted: z.boolean().optional(),
  conferenceProperties: z.object({
    allowedConferenceSolutionTypes: z.array(z.string()),
  }).optional(),
})

export type GoogleCalendarEntry = z.infer<typeof GoogleCalendarEntrySchema>

/**
 * Google Calendar list response.
 */
export const GoogleCalendarListSchema = z.object({
  kind: z.literal('calendar#calendarList'),
  etag: z.string().optional(),
  nextPageToken: z.string().optional(),
  nextSyncToken: z.string().optional(),
  items: z.array(GoogleCalendarEntrySchema),
})

export type GoogleCalendarList = z.infer<typeof GoogleCalendarListSchema>

// ============ Webhook Types (Calendar API push) ============

/**
 * Google Calendar webhook notification payload.
 */
export const GoogleCalendarNotificationSchema = z.object({
  channel_id: z.string(),
  resource_id: z.string(),
  resource_uri: z.string(),
  expiration: z.string().optional(),
})

export type GoogleCalendarNotification = z.infer<typeof GoogleCalendarNotificationSchema>
