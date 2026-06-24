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
    "2027-06-23T14:46:44.333Z"
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
    "2026-06-30T14:47:04.000Z"
  ),

  cookie(
    "fr",
    "1UOEKI5HamoAEPfTr.AWcdeXAK_RLVAkqyDeAHVzfx9qlVEYaCGfiYGtuWIQXXwiY1CO4.BqOpxT..AAA.0.0.BqOpxi.AWe2L2UdrT7Cw6c6Z3qa-CLffIM",
    "2026-09-21T14:46:58.692Z",
    true
  ),

  cookie(
    "locale",
    "en_GB",
    "2026-06-30T14:46:18.411Z"
  ),

  cookie(
    "presence",
    "C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1782226026333%2C%22v%22%3A1%7D",
    null
  ),

  cookie(
    "ps_l",
    "1",
    "2027-07-24T18:16:33.809Z",
    true,
    "Lax"
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
    "2026-06-30T14:47:04.000Z",
    false,
    "Lax"
  ),

  cookie(
    "xs",
    "15%3Am5d1VvKcUOcQkQ%3A2%3A1782225997%3A-1%3A-1%3A%3AAcw6zfb3Eosg9hh5LaTEmIP6zKNcsSk7DF4e-oxb5A",
    "2027-06-23T14:46:44.333Z",
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