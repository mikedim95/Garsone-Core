import { createHmac, timingSafeEqual } from "node:crypto";
import { FastifyInstance } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { db } from "../db/index.js";
import { deploymentForLegacySettings } from "../lib/venueDeployments.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { publishNodeConfigIfAddressable } from "./nodeAgents.js";

const adminOnly = [authMiddleware, requireRole(["architect"])];
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_AUDIENCE = "garsone-pi-release";
const githubJwks = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks")
);
const trustedRepositories = {
  "mikedim95/Garsone-Core": {
    id: "1096351894",
    component: "CORE",
  },
  "mikedim95/Garsone-Front": {
    id: "1096347595",
    component: "FRONT",
  },
} as const;

const releaseSchema = z.object({
  component: z.enum(["CORE", "FRONT"]),
  channel: z.enum(["STABLE", "STAGE"]),
  imageRef: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .regex(
      /@sha256:[a-f0-9]{64}$/i,
      "imageRef must be pinned to an immutable sha256 digest"
    ),
  sourceRepo: z.string().trim().min(1).max(255),
  sourceSha: z.string().trim().regex(/^[a-f0-9]{40}$/i),
  workflowRunId: z.string().trim().min(1).max(100),
  publishedAt: z.string().datetime(),
});

function releaseSignature(payload: z.infer<typeof releaseSchema>, secret: string) {
  const canonical = [
    payload.component,
    payload.channel,
    payload.imageRef,
    payload.sourceRepo,
    payload.sourceSha,
    payload.workflowRunId,
    payload.publishedAt,
    "",
  ].join("\n");
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

function signatureMatches(provided: string, expected: string) {
  const clean = provided.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clean)) return false;
  return timingSafeEqual(Buffer.from(clean, "hex"), Buffer.from(expected, "hex"));
}

async function authenticateReleaseRequest(
  request: any,
  payload: z.infer<typeof releaseSchema>
) {
  const authorization = String(request.headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : "";
  if (bearer) {
    const result = await jwtVerify(bearer, githubJwks, {
      issuer: GITHUB_OIDC_ISSUER,
      audience: GITHUB_OIDC_AUDIENCE,
    });
    const claims = result.payload as Record<string, unknown>;
    const repository = String(claims.repository || "");
    const trusted =
      trustedRepositories[repository as keyof typeof trustedRepositories];
    const expectedRef =
      payload.channel === "STABLE"
        ? "refs/heads/main"
        : "refs/heads/stage";
    if (
      !trusted ||
      trusted.id !== String(claims.repository_id || "") ||
      trusted.component !== payload.component ||
      repository !== payload.sourceRepo ||
      String(claims.ref || "") !== expectedRef ||
      String(claims.sha || "") !== payload.sourceSha ||
      String(claims.run_id || "") !== payload.workflowRunId ||
      !["push", "workflow_dispatch"].includes(String(claims.event_name || ""))
    ) {
      throw new Error("GitHub OIDC release claims do not match the payload");
    }
    const workflowRef = String(claims.workflow_ref || "");
    if (
      workflowRef &&
      workflowRef !==
        `${repository}/.github/workflows/docker-publish.yml@${expectedRef}`
    ) {
      throw new Error("GitHub OIDC workflow_ref is not trusted");
    }
    return "github-oidc";
  }

  // Optional HMAC fallback for controlled manual release tooling. GitHub
  // Actions uses short-lived OIDC and does not require a repository secret.
  const secret = String(process.env.PI_RELEASE_WEBHOOK_SECRET || "").trim();
  if (secret) {
    const expected = releaseSignature(payload, secret);
    const provided = String(request.headers["x-garsone-signature"] || "");
    if (signatureMatches(provided, expected)) return "hmac";
  }
  throw new Error("Release request is not authenticated");
}

export async function piReleaseRoutes(fastify: FastifyInstance) {
  fastify.post("/internal/pi-releases", async (request, reply) => {
    try {
      const payload = releaseSchema.parse(request.body ?? {});
      const publishedAt = new Date(payload.publishedAt);
      const ageMs = Math.abs(Date.now() - publishedAt.getTime());
      if (ageMs > 15 * 60 * 1000) {
        return reply.status(401).send({ error: "STALE_RELEASE_SIGNATURE" });
      }
      try {
        await authenticateReleaseRequest(request, payload);
      } catch (error) {
        fastify.log.warn(error, "Rejected unauthenticated Pi release");
        return reply.status(401).send({ error: "INVALID_RELEASE_SIGNATURE" });
      }

      const existing = await db.piRelease.findUnique({
        where: {
          channel_component_sourceSha: {
            channel: payload.channel,
            component: payload.component,
            sourceSha: payload.sourceSha,
          },
        },
      });
      if (existing) {
        return reply.send({
          ok: true,
          duplicate: true,
          releaseId: existing.id,
          rolloutCount: 0,
        });
      }

      const result = await db.$transaction(async (tx) => {
        const release = await tx.piRelease.create({
          data: {
            channel: payload.channel,
            component: payload.component,
            imageRef: payload.imageRef,
            sourceRepo: payload.sourceRepo,
            sourceSha: payload.sourceSha,
            workflowRunId: payload.workflowRunId,
            publishedAt,
          },
        });
        const candidates = await tx.venueDeployment.findMany({
          where: {
            target: "PI",
            desiredState: "RUNNING",
            autoUpdate: true,
            channel: payload.channel,
            nodeId: { not: null },
          },
          include: { store: true, node: true },
        });
        const rollouts: Array<{ node: any; store: any }> = [];

        for (const candidate of candidates) {
          const alreadyCurrent =
            payload.component === "CORE"
              ? candidate.desiredCoreImageRef === payload.imageRef
              : candidate.desiredFrontImageRef === payload.imageRef;
          if (alreadyCurrent || !candidate.node) continue;

          const message = `Automatic ${payload.component.toLowerCase()} rollout from ${payload.channel.toLowerCase()} release ${payload.sourceSha.slice(0, 12)}`;
          const deployment = await tx.venueDeployment.update({
            where: { id: candidate.id },
            data: {
              version: { increment: 1 },
              status: "PENDING",
              message,
              requestedAt: new Date(),
              ...(payload.component === "CORE"
                ? {
                    desiredCoreReleaseId: release.id,
                    desiredCoreImageRef: payload.imageRef,
                  }
                : {
                    desiredFrontReleaseId: release.id,
                    desiredFrontImageRef: payload.imageRef,
                  }),
            },
          });
          const node = await tx.nodeAgent.update({
            where: { id: candidate.node.id },
            data: {
              desiredConfigVersion: { increment: 1 },
              statusMessage: message,
            },
          });
          const settings =
            candidate.store.settingsJson &&
            typeof candidate.store.settingsJson === "object"
              ? (candidate.store.settingsJson as any)
              : {};
          const store = await tx.store.update({
            where: { id: candidate.store.id },
            data: {
              settingsJson: {
                ...settings,
                venueDeployment: deploymentForLegacySettings(deployment),
              },
            },
          });
          await tx.venueDeploymentEvent.create({
            data: {
              deploymentId: deployment.id,
              storeId: candidate.store.id,
              nodeId: candidate.node.id,
              releaseId: release.id,
              version: deployment.version,
              eventType: "AUTO_RELEASE",
              status: "PENDING",
              message,
              metaJson: {
                component: payload.component,
                channel: payload.channel,
                imageRef: payload.imageRef,
                sourceRepo: payload.sourceRepo,
                sourceSha: payload.sourceSha,
                workflowRunId: payload.workflowRunId,
              },
            },
          });
          rollouts.push({ node, store });
        }

        return { release, rollouts };
      });

      const notificationResults = await Promise.allSettled(
        result.rollouts.map(({ node, store }) =>
          publishNodeConfigIfAddressable(node, store)
        )
      );
      const notificationFailures = notificationResults.filter(
        (item) => item.status === "rejected"
      ).length;
      if (notificationFailures) {
        fastify.log.warn(
          { notificationFailures, releaseId: result.release.id },
          "Release persisted but one or more MQTT rollout notifications failed"
        );
      }

      return reply.status(202).send({
        ok: true,
        duplicate: false,
        releaseId: result.release.id,
        rolloutCount: result.rollouts.length,
        notificationFailures,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply
          .status(400)
          .send({ error: "INVALID_RELEASE", details: error.errors });
      }
      fastify.log.error(error, "Failed to register Pi release");
      return reply.status(500).send({ error: "FAILED_TO_REGISTER_RELEASE" });
    }
  });

  fastify.get(
    "/admin/pi-releases",
    { preHandler: adminOnly },
    async (request, reply) => {
      const query = z
        .object({
          channel: z.enum(["STABLE", "STAGE"]).optional(),
          take: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(request.query ?? {});
      const releases = await db.piRelease.findMany({
        where: query.channel ? { channel: query.channel } : undefined,
        orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
        take: query.take,
      });
      return reply.send({ releases });
    }
  );
}
