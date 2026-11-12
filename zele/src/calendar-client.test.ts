// Tests for CalendarClient.getEvent request shape and CalDAV error mapping.
// A single-uid read must address the object directly (one calendar-multiget),
// must not depend on a whole-calendar list REPORT, and a missing object must
// surface as NotFoundError instead of a thrown API error.

import { afterEach, describe, expect, test, vi } from 'vitest'
import type { CalendarClient } from './calendar-client.js'
import { NotFoundError } from './api-utils.js'

// tsdav binds globalThis.fetch once, when its module is first evaluated, so the
// dispatcher is installed before any import and each test arms it.
const stub = vi.hoisted(() => {
  const state: { handler: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null } = { handler: null }
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (!state.handler) return Promise.reject(new Error('no CalDAV stub armed for this test'))
    return state.handler(input, init)
  }) as typeof fetch
  return state
})

const EMAIL = 'kirukiru@example.com'
const CALENDAR_PATH = `/caldav/v2/${encodeURIComponent(EMAIL)}/events/`
const CALENDAR_URL = `https://apidata.googleusercontent.com${CALENDAR_PATH}`

function objectPath(uid: string): string {
  return `${CALENDAR_PATH}${encodeURIComponent(uid)}.ics`
}

// Weekly series: master (RRULE + EXDATE) plus one moved occurrence whose
// RECURRENCE-ID Google normalizes to UTC, as observed live.
function eventIcs({ uid, summary, recurring = false }: { uid: string; summary: string; recurring?: boolean }): string {
  const master = [
    'BEGIN:VEVENT',
    'DTSTART:20270110T010000Z',
    'DTEND:20270110T020000Z',
    ...(recurring ? ['RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE:20270117T010000Z'] : []),
    'DTSTAMP:20261112T000000Z',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'END:VEVENT',
  ]
  const override = recurring
    ? [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        'RECURRENCE-ID:20270124T010000Z',
        'DTSTART:20270125T060000Z',
        'DTEND:20270125T070000Z',
        'DTSTAMP:20261112T000000Z',
        `SUMMARY:${summary}`,
        'END:VEVENT',
      ]
    : []
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    ...master,
    ...override,
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

const DISCOVERY_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:CA="http://apple.com/ns/ical/">
  <D:response>
    <D:href>${CALENDAR_PATH}</D:href>
    <D:propstat>
      <D:status>HTTP/1.1 200 OK</D:status>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>AI</D:displayname>
        <C:calendar-timezone>Asia/Seoul</C:calendar-timezone>
        <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        <CS:getctag>ctag-1</CS:getctag>
        <D:supported-report-set><D:supportedReport><D:report><C:calendar-multiget/></D:report></D:supportedReport></D:supported-report-set>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`

type StoredObject = { data: string; etag: string }
type Request = { method: string; path: string; body: string }

function objectResponse(href: string, object: StoredObject): string {
  return `<D:response>
    <D:href>${href}</D:href>
    <D:propstat>
      <D:status>HTTP/1.1 200 OK</D:status>
      <D:prop>
        <D:getetag>${object.etag}</D:getetag>
        <C:calendar-data><![CDATA[${object.data}]]></C:calendar-data>
      </D:prop>
    </D:propstat>
  </D:response>`
}

function missingResponse(href: string): string {
  return `<D:response>
    <D:href>${href}</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>`
}

function multistatus(responses: string[]): Response {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:CA="http://apple.com/ns/ical/">' +
    responses.join('') +
    '</D:multistatus>'
  return new Response(xml, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } })
}

/**
 * Serves Google-shaped DAV answers for discovery PROPFINDs, calendar-query
 * list REPORTs and calendar-multiget object REPORTs. A multiget href that is
 * not in `objects` answers with the 404 sub-status Google returns. When
 * `failCalendarQuery` is set, list REPORTs throw the transient network error
 * the live CLI reported as "API call failed: TypeError: fetch failed".
 */
function requestedHrefs(body: string): string[] {
  return [...body.matchAll(/<[dD]:href>([^<]*)<\/[dD]:href>/g)].map((match) => match[1] ?? '')
}

function installCaldavStub(options: { objects: Map<string, StoredObject>; failCalendarQuery?: boolean }) {
  const requests: Request[] = []
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(rawUrl, 'https://apidata.googleusercontent.com').pathname
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push({ method, path, body })

    if (method === 'PROPFIND') {
      return new Response(DISCOVERY_XML, { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } })
    }

    if (method === 'REPORT' && body.includes('calendar-query')) {
      if (options.failCalendarQuery) throw new TypeError('fetch failed')
      return multistatus([...options.objects].map(([href, object]) => objectResponse(href, object)))
    }

    if (method === 'REPORT' && body.includes('calendar-multiget')) {
      return multistatus(requestedHrefs(body).map((href) => {
        const object = options.objects.get(href)
        return object ? objectResponse(href, object) : missingResponse(href)
      }))
    }

    throw new Error(`unexpected request ${method} ${rawUrl}`)
  }

  stub.handler = fetchStub
  return { requests }
}

async function newClient(): Promise<CalendarClient> {
  const { CalendarClient: Client } = await import('./calendar-client.js')
  return new Client({ accessToken: 'test-token', email: EMAIL, appId: 'test-app' })
}

afterEach(() => {
  stub.handler = null
})

describe('getEvent request shape', () => {
  test('single-uid read issues one multiget for the object href and no list query', async () => {
    const uid = 'series-1@example.com'
    const objects = new Map([[objectPath(uid), { data: eventIcs({ uid, summary: 'Weekly sync', recurring: true }), etag: '"etag-1"' }]])
    const server = installCaldavStub({ objects })

    const event = await (await newClient()).getEvent({ calendarId: EMAIL, eventId: uid })
    expect(event).not.toBeInstanceOf(Error)
    if (event instanceof Error) return
    expect(event.summary).toBe('Weekly sync')

    const reports = server.requests.filter((request) => request.method === 'REPORT')
    expect(reports.filter((request) => request.body.includes('calendar-query'))).toHaveLength(0)
    const multiGets = reports.filter((request) => request.body.includes('calendar-multiget'))
    expect(multiGets).toHaveLength(1)
    expect(requestedHrefs(multiGets[0]!.body)).toEqual([objectPath(uid)])
  })

  test('returns the event when the whole-calendar list query fails transiently', async () => {
    const uid = 'series-2@example.com'
    const objects = new Map([[objectPath(uid), { data: eventIcs({ uid, summary: 'Survives list failure', recurring: true }), etag: '"etag-2"' }]])
    installCaldavStub({ objects, failCalendarQuery: true })

    const event = await (await newClient()).getEvent({ calendarId: EMAIL, eventId: uid })
    expect(event).not.toBeInstanceOf(Error)
    if (event instanceof Error) return
    expect(event.summary).toBe('Survives list failure')
  })
})

describe('getEvent series semantics', () => {
  test('master with EXDATE and a moved RECURRENCE-ID override resolves to the same uid', async () => {
    const uid = 'series-4@example.com'
    const objects = new Map([[objectPath(uid), { data: eventIcs({ uid, summary: 'Moved occurrence', recurring: true }), etag: '"etag-5"' }]])
    installCaldavStub({ objects })

    const event = await (await newClient()).getEvent({ calendarId: EMAIL, eventId: uid })
    expect(event).not.toBeInstanceOf(Error)
    if (event instanceof Error) return
    expect(event.uid).toBe(uid)
    expect(event.recurrence).toEqual(['RRULE:FREQ=WEEKLY;COUNT=4'])
    expect(event.url).toBe(`${CALENDAR_URL}${encodeURIComponent(uid)}.ics`)
    expect(event.etag).toBe('"etag-5"')
  })

  test('missing uid ends in NotFoundError, not an API error', async () => {
    const uid = 'series-5@example.com'
    const objects = new Map([[objectPath(uid), { data: eventIcs({ uid, summary: 'Present' }), etag: '"etag-6"' }]])
    installCaldavStub({ objects })

    const event = await (await newClient()).getEvent({ calendarId: EMAIL, eventId: 'absent@example.com' })
    expect(event).toBeInstanceOf(NotFoundError)
  })

  test('object stored under a foreign href is found through the whole-calendar fallback', async () => {
    const uid = 'series-6@zele'
    // createEvent derives the filename from the uid and drops the domain suffix.
    const foreignPath = `${CALENDAR_PATH}f47ac10b-58cc-4372-a567-0e02b2c3d479.ics`
    const objects = new Map([[foreignPath, { data: eventIcs({ uid, summary: 'Foreign href' }), etag: '"etag-7"' }]])
    installCaldavStub({ objects })

    const event = await (await newClient()).getEvent({ calendarId: EMAIL, eventId: uid })
    expect(event).not.toBeInstanceOf(Error)
    if (event instanceof Error) return
    expect(event.uid).toBe(uid)
    expect(event.url).toBe(`${CALENDAR_URL}f47ac10b-58cc-4372-a567-0e02b2c3d479.ics`)
  })
})
