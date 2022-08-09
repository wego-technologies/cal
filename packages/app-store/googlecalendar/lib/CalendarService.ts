import { Credential, Prisma } from "@prisma/client";
import { GetTokenResponse } from "google-auth-library/build/src/auth/oauth2client";
import { Auth, calendar_v3, google } from "googleapis";

import { getLocation, getRichDescription } from "@calcom/lib/CalEventParser";
import CalendarService from "@calcom/lib/CalendarService";
import { HttpError } from "@calcom/lib/http-error";
import logger from "@calcom/lib/logger";
import prisma from "@calcom/prisma";
import type {
  Calendar,
  CalendarEvent,
  EventBusyDate,
  IntegrationCalendar,
  NewCalendarEventType,
} from "@calcom/types/Calendar";

import getAppKeysFromSlug from "../../_utils/getAppKeysFromSlug";

interface GoogleCalError extends Error {
  code?: number;
}

export default class GoogleCalendarService implements Calendar {
  private url = "";
  private integrationName = "";
  private auth: Promise<{ getToken: () => Promise<MyGoogleAuth> }>;
  private log: typeof logger;
  private client_id = "";
  private client_secret = "";
  private redirect_uri = "";

  constructor(credential: Credential) {
    this.integrationName = "google_calendar";

    this.auth = this.googleAuth(credential).then((m) => m);

    this.log = logger.getChildLogger({ prefix: [`[[lib] ${this.integrationName}`] });
  }

  private googleAuth = async (credential: Credential) => {
    const appKeys = await getAppKeysFromSlug("google-calendar");
    if (typeof appKeys.client_id === "string") this.client_id = appKeys.client_id;
    if (typeof appKeys.client_secret === "string") this.client_secret = appKeys.client_secret;
    if (typeof appKeys.redirect_uris === "object" && Array.isArray(appKeys.redirect_uris)) {
      this.redirect_uri = appKeys.redirect_uris[0] as string;
    }
    if (!this.client_id) throw new HttpError({ statusCode: 400, message: "Google client_id missing." });
    if (!this.client_secret)
      throw new HttpError({ statusCode: 400, message: "Google client_secret missing." });
    if (!this.redirect_uri) throw new HttpError({ statusCode: 400, message: "Google redirect_uri missing." });

    const myGoogleAuth = new MyGoogleAuth(this.client_id, this.client_secret, this.redirect_uri);

    const googleCredentials = credential.key as Auth.Credentials;
    myGoogleAuth.setCredentials(googleCredentials);

    const isExpired = () => myGoogleAuth.isTokenExpiring();

    const refreshAccessToken = () =>
      myGoogleAuth
        .refreshToken(googleCredentials.refresh_token)
        .then(async (res: GetTokenResponse) => {
          const token = res.res?.data;
          googleCredentials.access_token = token.access_token;
          googleCredentials.expiry_date = token.expiry_date;
          await prisma.credential.update({
            where: {
              id: credential.id,
            },
            data: {
              key: googleCredentials as Prisma.InputJsonValue,
            },
          });
          myGoogleAuth.setCredentials(googleCredentials);
          return myGoogleAuth;
        })
        .catch((err) => {
          this.log.error("Error refreshing google token", err);

          return myGoogleAuth;
        });

    return {
      getToken: () => (!isExpired() ? Promise.resolve(myGoogleAuth) : refreshAccessToken()),
    };
  };

  async createEvent(calEventRaw: CalendarEvent): Promise<NewCalendarEventType> {
    return new Promise(async (resolve, reject) => {
      const auth = await this.auth;
      const myGoogleAuth = await auth.getToken();
      const payload: calendar_v3.Schema$Event = {
        summary: calEventRaw.title,
        description: getRichDescription(calEventRaw),
        start: {
          dateTime: calEventRaw.startTime,
          timeZone: calEventRaw.organizer.timeZone,
        },
        end: {
          dateTime: calEventRaw.endTime,
          timeZone: calEventRaw.organizer.timeZone,
        },
        attendees: [
          { ...calEventRaw.organizer, organizer: true, responseStatus: "accepted" },
          ...calEventRaw.attendees.map((attendee) => ({ ...attendee, responseStatus: "accepted" })),
        ],
        reminders: {
          useDefault: true,
        },
      };

      if (calEventRaw.location) {
        payload["location"] = getLocation(calEventRaw);
      }

      if (calEventRaw.conferenceData && calEventRaw.location === "integrations:google:meet") {
        payload["conferenceData"] = calEventRaw.conferenceData;
      }
      const calendar = google.calendar({
        version: "v3",
      });
      const selectedCalendar = calEventRaw.destinationCalendar?.externalId
        ? calEventRaw.destinationCalendar.externalId
        : "primary";
      calendar.events.insert(
        {
          auth: myGoogleAuth,
          calendarId: selectedCalendar,
          requestBody: payload,
          conferenceDataVersion: 1,
        },
        function (error, event) {
          if (error || !event?.data) {
            console.error("There was an error contacting google calendar service: ", error);
            return reject(error);
          }

          if (event && event.data.id && event.data.hangoutLink) {
            calendar.events.patch({
              // Update the same event but this time we know the hangout link
              calendarId: selectedCalendar,
              auth: myGoogleAuth,
              eventId: event.data.id || "",
              requestBody: {
                description: getRichDescription({
                  ...calEventRaw,
                  additionalInformation: { hangoutLink: event.data.hangoutLink },
                }),
              },
            });
          }
          return resolve({
            uid: "",
            ...event.data,
            id: event.data.id || "",
            additionalInfo: {
              hangoutLink: event.data.hangoutLink || "",
            },
            type: "google_calendar",
            password: "",
            url: "",
          });
        }
      );
    });
  }

  async updateEvent(uid: string, event: CalendarEvent, externalCalendarId: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const auth = await this.auth;
      const myGoogleAuth = await auth.getToken();
      const payload: calendar_v3.Schema$Event = {
        summary: event.title,
        description: getRichDescription(event),
        start: {
          dateTime: event.startTime,
          timeZone: event.organizer.timeZone,
        },
        end: {
          dateTime: event.endTime,
          timeZone: event.organizer.timeZone,
        },
        attendees: [{ ...event.organizer, organizer: true, responseStatus: "accepted" }, ...event.attendees],
        reminders: {
          useDefault: true,
        },
      };

      if (event.location) {
        payload["location"] = getLocation(event);
      }

      if (event.conferenceData && event.location === "integrations:google:meet") {
        payload["conferenceData"] = event.conferenceData;
      }

      const calendar = google.calendar({
        version: "v3",
        auth: myGoogleAuth,
      });

      const selectedCalendar = externalCalendarId
        ? externalCalendarId
        : event.destinationCalendar?.externalId;

      calendar.events.update(
        {
          auth: myGoogleAuth,
          calendarId: selectedCalendar,
          eventId: uid,
          sendNotifications: true,
          sendUpdates: "all",
          requestBody: payload,
          conferenceDataVersion: 1,
        },
        function (err, evt) {
          if (err) {
            console.error("There was an error contacting google calendar service: ", err);

            return reject(err);
          }

          if (evt && evt.data.id && evt.data.hangoutLink && event.location === "integrations:google:meet") {
            calendar.events.patch({
              // Update the same event but this time we know the hangout link
              calendarId: selectedCalendar,
              auth: myGoogleAuth,
              eventId: evt.data.id || "",
              requestBody: {
                description: getRichDescription({
                  ...event,
                  additionalInformation: { hangoutLink: evt.data.hangoutLink },
                }),
              },
            });
            return resolve({
              uid: "",
              ...evt.data,
              id: evt.data.id || "",
              additionalInfo: {
                hangoutLink: evt.data.hangoutLink || "",
              },
              type: "google_calendar",
              password: "",
              url: "",
            });
          }
          return resolve(evt?.data);
        }
      );
    });
  }

  async deleteEvent(uid: string, event: CalendarEvent, externalCalendarId?: string | null): Promise<void> {
    return new Promise(async (resolve, reject) => {
      const auth = await this.auth;
      const myGoogleAuth = await auth.getToken();
      const calendar = google.calendar({
        version: "v3",
        auth: myGoogleAuth,
      });

      const defaultCalendarId = "primary";
      const calendarId = externalCalendarId ? externalCalendarId : event.destinationCalendar?.externalId;

      calendar.events.delete(
        {
          auth: myGoogleAuth,
          calendarId: calendarId ? calendarId : defaultCalendarId,
          eventId: uid,
          sendNotifications: true,
          sendUpdates: "all",
        },
        function (err: GoogleCalError | null, event) {
          if (err) {
            /**
             *  410 is when an event is already deleted on the Google cal before on cal.com
             *  404 is when the event is on a different calendar
             */
            if (err.code === 410) return resolve();
            console.error("There was an error contacting google calendar service: ", err);
            if (err.code === 404) return resolve();
            return reject(err);
          }
          return resolve(event?.data);
        }
      );
    });
  }

  async getAvailability(
    dateFrom: string,
    dateTo: string,
    selectedCalendars: IntegrationCalendar[]
  ): Promise<EventBusyDate[]> {
    return new Promise(async (resolve, reject) => {
      const auth = await this.auth;
      const myGoogleAuth = await auth.getToken();
      const calendar = google.calendar({
        version: "v3",
        auth: myGoogleAuth,
      });
      const selectedCalendarIds = selectedCalendars
        .filter((e) => e.integration === this.integrationName)
        .map((e) => e.externalId);
      if (selectedCalendarIds.length === 0 && selectedCalendars.length > 0) {
        // Only calendars of other integrations selected
        resolve([]);
        return;
      }

      (selectedCalendarIds.length === 0
        ? calendar.calendarList
            .list()
            .then((cals) => cals.data.items?.map((cal) => cal.id).filter(Boolean) || [])
        : Promise.resolve(selectedCalendarIds)
      )
        .then((calsIds) => {
          calendar.freebusy.query(
            {
              requestBody: {
                timeMin: dateFrom,
                timeMax: dateTo,
                items: calsIds.map((id) => ({ id: id })),
              },
            },
            (err, apires) => {
              if (err) {
                reject(err);
              }
              let result: Prisma.PromiseReturnType<CalendarService["getAvailability"]> = [];

              if (apires?.data.calendars) {
                result = Object.values(apires.data.calendars).reduce((c, i) => {
                  i.busy?.forEach((busyTime) => {
                    c.push({
                      start: busyTime.start || "",
                      end: busyTime.end || "",
                    });
                  });
                  return c;
                }, [] as typeof result);
              }
              resolve(result);
            }
          );
        })
        .catch((err) => {
          this.log.error("There was an error contacting google calendar service: ", err);

          reject(err);
        });
    });
  }

  async listCalendars(): Promise<IntegrationCalendar[]> {
    return new Promise(async (resolve, reject) => {
      const auth = await this.auth;
      const myGoogleAuth = await auth.getToken();
      const calendar = google.calendar({
        version: "v3",
        auth: myGoogleAuth,
      });

      calendar.calendarList
        .list()
        .then((cals) => {
          resolve(
            cals.data.items?.map((cal) => {
              const calendar: IntegrationCalendar = {
                externalId: cal.id ?? "No id",
                integration: this.integrationName,
                name: cal.summary ?? "No name",
                primary: cal.primary ?? false,
                readOnly: !(cal.accessRole === "reader" || cal.accessRole === "owner") && true,
              };
              return calendar;
            }) || []
          );
        })
        .catch((err: Error) => {
          this.log.error("There was an error contacting google calendar service: ", err);

          reject(err);
        });
    });
  }
}

class MyGoogleAuth extends google.auth.OAuth2 {
  constructor(client_id: string, client_secret: string, redirect_uri: string) {
    super(client_id, client_secret, redirect_uri);
  }

  isTokenExpiring() {
    return super.isTokenExpiring();
  }

  async refreshToken(token: string | null | undefined) {
    return super.refreshToken(token);
  }
}
