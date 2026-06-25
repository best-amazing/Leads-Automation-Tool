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
    "2027-06-25T12:43:37.550Z"
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
    "2026-07-02T13:11:06.000Z"
  ),

  cookie(
    "fr",
    "1L1gb6NW4g6UIQxT0.AWfIputg9OONfMsTL5IlJstX6GlWorqR7Dc_iSBk3h1z4shTFLE.BqPSJ3..AAA.0.0.BqPSjV.AWe1KRgE3HUePaeGwcgc6lj3-p8",
    "2026-09-23T13:10:48.256Z",
    true
  ),

  cookie(
    "locale",
    "en_GB",
    "2026-06-30T14:46:18.411Z"
  ),

  cookie(
    "presence",
    "C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1782393066695%2C%22v%22%3A1%7D",
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
    "2026-07-02T13:11:06.000Z",
    false,
    "Lax"
  ),

  cookie(
    "xs",
    "15%3Am5d1VvKcUOcQkQ%3A2%3A1782225997%3A-1%3A-1%3A%3AAcylGgkaHn0n_bSizd2zj4JWqMguaONRPaAXT2VUCg8",
    "2027-06-25T12:43:37.550Z",
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