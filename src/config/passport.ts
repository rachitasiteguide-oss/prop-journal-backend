import passport from 'passport';
import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import { env } from './env';
import { prisma } from './db';

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

        // Upsert user — find by googleId first, fallback to email
        let user = await prisma.user.findUnique({
          where: { googleId: profile.id },
        });

        if (!user) {
          user = await prisma.user.upsert({
            where: { email },
            update: {
              googleId: profile.id,
              name: profile.displayName,
              avatar: profile.photos?.[0]?.value ?? null,
            },
            create: {
              email,
              googleId: profile.id,
              name: profile.displayName,
              avatar: profile.photos?.[0]?.value ?? null,
            },
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
