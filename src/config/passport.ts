import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { env } from './env';
import { prisma } from './db';
import { sendWelcomeEmail } from '../utils/email';
import { logger } from '../utils/logger';

passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      callbackURL: env.GOOGLE_CALLBACK_URL,
      scope: ['profile', 'email'],
    },
    async (
      _accessToken: string,
      _refreshToken: string,
      profile: Profile,
      done: (error: unknown, user?: Express.User | false) => void,
    ) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) {
          return done(new Error('No email provided by Google'));
        }

        // Match by googleId, then by email, then create. Tracking the "is this
        // a brand-new account?" branch explicitly (rather than using upsert)
        // is what lets us fire the welcome email on first signup only.
        let user = await prisma.user.findUnique({ where: { googleId: profile.id } });
        let isNew = false;

        if (!user) {
          const existingByEmail = await prisma.user.findUnique({ where: { email } });
          if (existingByEmail) {
            // Existing email/password account — link the Google identity.
            user = await prisma.user.update({
              where: { email },
              data: {
                googleId: profile.id,
                name: existingByEmail.name ?? profile.displayName,
                avatar: existingByEmail.avatar ?? profile.photos?.[0]?.value ?? null,
              },
            });
          } else {
            user = await prisma.user.create({
              data: {
                email,
                googleId: profile.id,
                name: profile.displayName,
                avatar: profile.photos?.[0]?.value ?? null,
              },
            });
            isNew = true;
          }
        }

        if (isNew) {
          // Fire-and-forget — never block the OAuth callback on email delivery.
          sendWelcomeEmail(user.email, user.name).catch((err) => {
            logger.error(`Welcome email failed for ${user!.email}: ${(err as Error).message}`);
          });
        }

        return done(null, user as unknown as Express.User);
      } catch (error) {
        return done(error);
      }
    },
  ),
);

export default passport;
