import { compare, hash } from "bcryptjs";
import type { NextApiRequest } from "next";
import type { Session } from "next-auth";
import { getSession as getSessionInner, GetSessionParams } from "next-auth/react";

import { HttpError } from "@calcom/lib/http-error";

export async function hashPassword(password: string) {
  const hashedPassword = await hash(password, 12);
  return hashedPassword;
}

export async function verifyPassword(password: string, hashedPassword: string) {
  const isValid = await compare(password, hashedPassword);
  return isValid;
}

export async function getSession(options: GetSessionParams): Promise<Session | null> {
  const session = await getSessionInner(options);

  // that these are equal are ensured in `[...nextauth]`'s callback
  return session as Session | null;
}

export function isPasswordValid(password: string): boolean;
export function isPasswordValid(
  password: string,
  breakdown: boolean
): { caplow: boolean; num: boolean; min: boolean };
export function isPasswordValid(password: string, breakdown?: boolean) {
  let cap = false, // Has uppercase characters
    low = false, // Has lowercase characters
    num = false, // At least one number
    min = false; // Seven characters
  if (password.length > 6) min = true;
  for (let i = 0; i < password.length; i++) {
    if (!isNaN(parseInt(password[i]))) num = true;
    else {
      if (password[i] === password[i].toUpperCase()) cap = true;
      if (password[i] === password[i].toLowerCase()) low = true;
    }
  }
  return !!breakdown ? { caplow: cap && low, num, min } : cap && low && num && min;
}

type CtxOrReq = { req: NextApiRequest; ctx?: never } | { ctx: { req: NextApiRequest }; req?: never };

export const ensureSession = async (ctxOrReq: CtxOrReq) => {
  const session = await getSession(ctxOrReq);
  if (!session?.user.id) throw new HttpError({ statusCode: 401, message: "Unauthorized" });
  return session;
};
