import { Router, type Router as ExpressRouter } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "../lib/auth.js";

export const authRouter: ExpressRouter = Router();

authRouter.all("/*splat", toNodeHandler(auth));
