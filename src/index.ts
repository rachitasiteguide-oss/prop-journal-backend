import "./types";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import { env } from "./config/env";
import "./config/passport";
import { connectDB, disconnectDB } from "./config/db";
import { logger } from "./utils/logger";
import router from "./routes";
import {
  notFoundHandler,
  globalErrorHandler,
} from "./middlewares/errorHandler";
import { startOrphanRunSweeper, stopOrphanRunSweeper } from "./services/orphanRunSweeper";
import { startWeeklyReviewScheduler, stopWeeklyReviewScheduler } from "./services/weeklyReviewScheduler";

const app = express();

// ── Security & parsing middleware ───────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  "http://localhost:3000",
  ...(env.CLIENT_URL ? [env.CLIENT_URL] : []),
];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
let isDBConnected = false;

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/v1", router);
app.get("/health", (_, res) => {
  res.status(200).json({
    status: "ok",
    db: isDBConnected ? "connected" : "disconnected",
  });
});

// ── Error handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

async function connectWithRetry(maxRetries = 5, delay = 3000) {
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await connectDB();
      isDBConnected = true;
      logger.info("✅ Database connected");
      return;
    } catch (err) {
      isDBConnected = false;
      logger.error(`DB connection failed (attempt ${i})`);

      if (i === maxRetries) throw err;

      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// ── Start server ─────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  try {
    await connectWithRetry();
  } catch (err) {
    logger.error("⚠️ DB unavailable, starting server anyway...");
  }

  const server = app.listen(env.PORT, () => {
    logger.info(
      `🚀 Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`,
    );
  });

  // Sweep any backtest sessions stuck in RUNNING from a previous process,
  // and keep sweeping every minute for runs that hang past the timeout.
  startOrphanRunSweeper();

  // Weekly AI review emails — fires once/week (Mon 13:00 UTC).
  startWeeklyReviewScheduler();

  setInterval(async () => {
    try {
      await connectDB();
      if (!isDBConnected) {
        logger.info("🔄 DB reconnected");
      }
      isDBConnected = true;
    } catch {
      if (isDBConnected) {
        logger.warn("⚠️ DB connection lost");
      }
      isDBConnected = false;
    }
  }, 10000);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully`);
    stopOrphanRunSweeper();
    stopWeeklyReviewScheduler();
    server.close(async () => {
      await disconnectDB();
      logger.info("Database disconnected. Goodbye.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

bootstrap().catch((err) => {
  logger.error("Failed to start server:", err);
});

export default app;
