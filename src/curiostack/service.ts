import {
  GoogleCloudRunV2Service,
  type GoogleCloudRunV2ServiceTemplateContainersEnv,
} from "@cdktf/provider-google-beta/lib/google-cloud-run-v2-service/index.js";
import { CloudRunServiceIamMember } from "@cdktf/provider-google/lib/cloud-run-service-iam-member/index.js";
import { ProjectIamMember } from "@cdktf/provider-google/lib/project-iam-member/index.js";
import { SecretManagerSecretIamMember } from "@cdktf/provider-google/lib/secret-manager-secret-iam-member/index.js";
import type { SecretManagerSecretVersion } from "@cdktf/provider-google/lib/secret-manager-secret-version/index.js";
import { ServiceAccountIamMember } from "@cdktf/provider-google/lib/service-account-iam-member/index.js";
import { ServiceAccount } from "@cdktf/provider-google/lib/service-account/index.js";
import type { ITerraformDependable } from "cdktf";
import { Construct } from "constructs";
import type { CurioStack } from "./index.js";

export interface CurioStackServiceConfig {
  /** The name of the service. */
  name: string;

  /** The image tag to deploy. Defaults to `main`. */
  imageTag?: string;

  /** The configuration environment of the service, e.g. `devs` or `prod`. Defaults to the suffix after hyphen of the GCP project.  */
  environment?: string;

  /** Whether the service should be available publically to anonymous users. */
  public?: boolean;

  /** Environment variables to set on the service. */
  env?: Record<string, string>;

  /** Secrets to set as environment variables on the service. */
  envSecrets?: Record<
    string,
    Pick<SecretManagerSecretVersion, "secret" | "version">
  >;

  /** The {@link CurioStack} to configure the service with. */
  curiostack: CurioStack;

  dependsOn?: ITerraformDependable[];
}

export class CurioStackService extends Construct {
  /** The created cloud run service. */
  public readonly run: GoogleCloudRunV2Service;
  /**
   * The service account that executes the service.
   * Any resources needed by the service should define IAM membership to this service account.
   */
  public readonly serviceAccount: ServiceAccount;

  constructor(scope: Construct, config: CurioStackServiceConfig) {
    super(scope, config.name);

    const repository = config.curiostack.dockerRepository;
    const imageName = `${repository.location}-docker.pkg.dev/${
      repository.project
    }/${repository.name}/${config.name}:${config.imageTag ?? "main"}`;

    // TODO: Only allow from internal after setting up Firebase.
    const ingress = "INGRESS_TRAFFIC_ALL";

    this.serviceAccount = new ServiceAccount(this, "service-account", {
      accountId: `service-${config.name}`,
    });

    const project = config.curiostack.project;

    new ProjectIamMember(this, "service-account-metrics", {
      project: project,
      role: "roles/monitoring.metricWriter",
      member: this.serviceAccount.member,
    });

    new ProjectIamMember(this, "service-account-traces", {
      project: project,
      role: "roles/cloudtrace.agent",
      member: this.serviceAccount.member,
    });

    new ProjectIamMember(this, "service-account-profiles", {
      project: project,
      role: "roles/cloudprofiler.agent",
      member: this.serviceAccount.member,
    });

    // Allow GitHub repo to deploy.
    new ServiceAccountIamMember(this, "cloudrun-github", {
      serviceAccountId: this.serviceAccount.name,
      role: "roles/iam.serviceAccountUser",
      member: config.curiostack.githubEnvironmentIamMember,
    });

    const dependsOn = config.dependsOn ?? [];
    dependsOn.push(config.curiostack.runService);

    const env: GoogleCloudRunV2ServiceTemplateContainersEnv[] = [];
    env.push({
      name: "CONFIG_ENV",
      value: config.environment ?? project.split("-")[1],
    });
    env.push({
      name: "OTEL_METRICS_EXPORTER",
      value: "otlp",
    });
    env.push({
      name: "OTEL_TRACES_EXPORTER",
      value: "otlp",
    });
    env.push({
      name: "OTEL_SERVICE_NAME",
      value: config.name,
    });
    if (config.public) {
      env.push({
        name: "OTEL_TRACES_SAMPLER",
        value: "always_on",
      });
    }

    env.push({
      name: "LOGGING_JSON",
      value: "true",
    });

    for (const [name, value] of Object.entries(config.env ?? {})) {
      env.push({
        name,
        value,
      });
    }

    for (const [name, secret] of Object.entries(config.envSecrets ?? {})) {
      env.push({
        name,
        valueSource: {
          secretKeyRef: {
            secret: secret.secret,
            version: secret.version,
          },
        },
      });

      const secretIam = new SecretManagerSecretIamMember(
        this,
        `secret-accessor-${name}`,
        {
          secretId: secret.secret,
          role: "roles/secretmanager.secretAccessor",
          member: this.serviceAccount.member,
        },
      );
      dependsOn.push(secretIam);
    }

    const ghcrRepo = config.curiostack.ghcrRepository;
    const otelCollectorImage = `${ghcrRepo.location}-docker.pkg.dev/${ghcrRepo.project}/${ghcrRepo.name}/curioswitch/go-usegcp/otel-collector:latest`;

    this.run = new GoogleCloudRunV2Service(this, "service", {
      name: config.name,
      location: config.curiostack.location,
      customAudiences: [config.name],
      ingress,
      template: {
        executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
        serviceAccount: this.serviceAccount.email,
        scaling: {
          minInstanceCount: 0,
          maxInstanceCount: 1,
        },
        containers: [
          {
            image: imageName,
            name: "app",
            resources: {
              cpuIdle: true,
              startupCpuBoost: true,
            },
            startupProbe: {
              periodSeconds: 1,
              failureThreshold: 10,
              initialDelaySeconds: 1,
              httpGet: {
                path: "/internal/health",
                port: 8080,
              },
            },
            livenessProbe: {
              periodSeconds: 5,
              failureThreshold: 3,
              httpGet: {
                path: "/internal/health",
                port: 8080,
              },
            },
            env: [...env],
            ports: {
              name: "h2c",
              containerPort: 8080,
            },
          },
          {
            image: otelCollectorImage,
            name: "otel",
            args: ["--config", "/otel/config.yaml"],
            resources: {
              cpuIdle: true,
              startupCpuBoost: true,
              limits: {
                cpu: "1000m",
                memory: "256Mi",
              },
            },
            // Startup time is relatively slow, we don't add a startup probe so
            // the main container can serve requests as soon as it's ready.
          },
        ],
      },
      dependsOn,
      lifecycle: {
        ignoreChanges: config.imageTag
          ? undefined
          : [
              // Allow external deployment.
              "client",
              "client_version",
              "template[0].revision",
              "template[0].containers[0].image",
            ],
      },
    });

    if (config.public) {
      new CloudRunServiceIamMember(this, "publicaccess", {
        location: this.run.location,
        service: this.run.name,
        role: "roles/run.invoker",
        member: "allUsers",
      });
    }
  }
}
