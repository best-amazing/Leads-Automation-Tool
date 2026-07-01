// scripts/build-fb-session.ts
import * as fs from "fs";

type SameSite = "None" | "Lax" | "Strict";

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: SameSite;
}

const cookie = (
  name: string,
  value: string,
  expires: string | null,
  httpOnly = false,
  sameSite: SameSite = "None"
): Cookie => ({
  name,
  value,
  domain: ".facebook.com",
  path: "/",
  expires: expires
    ? Math.floor(new Date(expires).getTime() / 1000)
    : -1, // Session cookie
  httpOnly,
  secure: true,
  sameSite,
});

const cookies: Cookie[] = [
  cookie(
    "c_user",
    "61590657779105",
    "2027-07-01T09:43:17.155Z"
  ),

  cookie(
    "datr",
    "JJU6apxbQzoXDQ2kX8kJwu9M",
    "2027-07-28T14:16:05.181Z",
    true
  ),

  cookie(
    "dpr",
    "1.25",
    "2026-07-08T09:43:16.000Z"
  ),

  cookie(
    "fr",
    "152qDuQwze1Qreg5O.AWd_izRbuJ1T4itxJMPkds6i49Aa3JI3zGhQMUEWzMyVvyrXqjg.BqROE1..AAA.0.0.BqROE1.AWfU9hrtnP8DKIWZWE-Ic1_6uTs",
    "2026-09-29T09:43:17.155Z",
    true
  ),

  cookie(
    "presence",
    "C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1782898997236%2C%22v%22%3A1%7D",
    null
  ),

  cookie(
    "ps_l",
    "1",
    "2027-07-29T20:16:45.287Z",
    true,
    "Lax"
  ),

  cookie(
    "ps_n",
    "1",
    "2027-07-29T20:16:45.287Z",
    true
  ),

  cookie(
    "sb",
    "JJU6aoaq6uMhiYN8eJf21aAL",
    "2027-07-28T14:46:41.233Z",
    true
  ),

  cookie(
    "wd",
    "976x776",
    "2026-07-08T09:52:05.000Z",
    false,
    "Lax"
  ),

  cookie(
    "xs",
    "15%3Am5d1VvKcUOcQkQ%3A2%3A1782225997%3A-1%3A-1%3A%3AAcyRCJGm7v2riF-JTSCRq5SK1QB3wIRhwKUHf70OuqQ",
    "2027-07-01T09:43:17.155Z",
    true
  ),
];

const storageState = {
  cookies,
  origins: [],
};

fs.writeFileSync(
  "facebook-session.json",
  JSON.stringify(storageState, null, 2)
);

console.log("✓ facebook-session.json created");