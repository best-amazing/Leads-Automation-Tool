// scripts/build-fb-session.ts
import * as fs from "fs";

const cookies = [
  {
    name: "c_user",
    value: "61590657779105",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-09T19:07:16.583Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "datr",
    value: "xE4oapKrj-5sXlMtdyHvipP6",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-14T17:35:01.823Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "dpr",
    value: "1.25",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-16T19:07:17.000Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "fr",
    value:
      "1mFU9r4ICqx8VSK22.AWcD3tYMjXYXfFZu18iCYy58qNFmlKJAHG58F5cuU_PJ92bIqyU.BqKGRj..AAA.0.0.BqKGRj.AWc6TQ_BZVHN11SgzrQzAN46dxY",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-09-07T19:07:16.583Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "sb",
    value: "yE4oan097kDveMfaESZi6czY",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-14T17:35:15.608Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "xs",
    value:
      "20%3AH_XZlG1bUUuydg%3A2%3A1781026512%3A-1%3A-1%3A%3AAcyGWiwA3wTzHb4tqygzb_BMmMCjcft_YY-5JcJrJw",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-09T19:07:16.583Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "ps_l",
    value: "1",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-14T17:35:16.691Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  },
  {
    name: "ps_n",
    value: "1",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-14T17:35:16.691Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "wd",
    value: "976x776",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-16T19:13:40.000Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "Lax" as const,
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
