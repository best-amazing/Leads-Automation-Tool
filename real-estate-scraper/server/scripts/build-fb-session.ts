// scripts/build-fb-session.ts
import * as fs from "fs";

const cookies = [
  {
    name: "c_user",
    value: "61590657779105",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-05T19:44:49.487Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "datr",
    value: "mDcfapSHHjqeE0y2VuR8mpps",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-07T20:05:45.425Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "dpr",
    value: "1.25",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-12T19:44:52.000Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "fr",
    value:
      "1pdU01hb0FduI6Jrp.AWetVWjbxjQUv7q_Fmgef8TxdIZQhdq3P4Y_6gJFGDuV2uRaKwY.BqIycx..AAA.0.0.BqIycx.AWf7-8TbMwEAnHHJCypybdfq4Ac",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-09-03T19:44:49.487Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "sb",
    value: "mDcfasMEhJjdVkE12qGFYF9_",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-10T19:44:46.641Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "xs",
    value:
      "41%3AbnjD4giIa8u_rA%3A2%3A1780688685%3A-1%3A-1%3A%3AAcxCoUOpYXUdzD4Jt6fXb71zDhbq1n3EwmAbv13iWA",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-06-05T19:44:49.488Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "ps_l",
    value: "1",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-10T17:26:56.700Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  },
  {
    name: "ps_n",
    value: "1",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2027-07-10T17:26:56.700Z").getTime() / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "locale",
    value: "en_GB",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-09T20:06:00.486Z").getTime() / 1000,
    httpOnly: false,
    secure: true,
    sameSite: "None" as const,
  },
  {
    name: "wd",
    value: "976x776",
    domain: ".facebook.com",
    path: "/",
    expires: new Date("2026-06-12T19:44:52.000Z").getTime() / 1000,
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
