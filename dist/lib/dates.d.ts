export declare function normalizeDate(date: string, timezone: string): Date;
export declare function dateRangeForDay(date: string, timezone: string): {
    start: Date;
    end: Date;
};
export declare function parseAppointmentAt(appointmentTimeRaw: string, dateOfService: Date, clinicTimezone: string): {
    appointmentTime: string | null;
    appointmentAt: Date | null;
    error: string | null;
};
