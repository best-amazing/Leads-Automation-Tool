// scripts/build-fb-session.ts
import * as fs from "fs";

const cookies = [
  {
    name: "c_user",
    value: "61590657779105",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-08T17:31:50.440Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "datr",
    value: "a_wmajdJxHF-eaYbXSIkqGDn",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-13T17:31:23.816Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "dpr",
    value: "1.25",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-15T17:32:22.000Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "fr",
    value:
      "1RXolsIDKQ9evTl9N.AWcNglCVXaPzHA4CO1L9X4bNoRgasLzD2njasbj5dqiUbpTjT5E.BqJvyG..AAA.0.0.BqJvyG.AWfCPd7PbPJ7RgV0OZlFzHLDQNc",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-09-06T17:31:50.440Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "presence",
    value:
      "C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1780939943304%2C%22v%22%3A1%7D",
    domain: ".facebook.com",
    path: "/",
    expires: -1, // Session cookie
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "ps_l",
    value: "1",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-13T16:22:28.689Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  },
  {
    name: "sb",
    value: "dfwmalmPejgZspm_ei1KhwOv",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-13T17:31:46.805Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "wd",
    value: "976x776",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-15T18:19:29.000Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "Lax" as const,
  },
  {
    name: "xs",
    value:
      "28%3AvLfgSr4IeFonxg%3A2%3A1780939905%3A-1%3A-1%3A%3AAcwKFMsoxWqbsfjbdM-RXyHigYarqbiirQza8G1PyQ",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-08T17:31:50.440Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
];

const storageState = {
  cookies,
  origins: [],
};

fs.writeFileSync(
  "facebook-session.json",
  JSON.stringify(storageState, null, 2),
);
console.log("✓ facebook-session.json created");
