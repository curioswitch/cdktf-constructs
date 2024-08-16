import { DataGoogleIamWorkloadIdentityPool } from "@cdktf/provider-google-beta/lib/data-google-iam-workload-identity-pool/index.js";
import { ArtifactRegistryRepositoryIamMember } from "@cdktf/provider-google/lib/artifact-registry-repository-iam-member/index.js";
import { ArtifactRegistryRepository } from "@cdktf/provider-google/lib/artifact-registry-repository/index.js";
import { IdentityPlatformConfig } from "@cdktf/provider-google/lib/identity-platform-config/index.js";
import { ProjectIamCustomRole } from "@cdktf/provider-google/lib/project-iam-custom-role/index.js";
import { ProjectIamMember } from "@cdktf/provider-google/lib/project-iam-member/index.js";
import { ProjectService } from "@cdktf/provider-google/lib/project-service/index.js";
import type { TerraformProvider } from "cdktf";
import { Construct } from "constructs";

export * from "./service.js";

export interface CurioStackConfig {
  /** The project ID to provision in. */
  project: string;

  /** The GCP location to provision resources in, e.g., us-central1. */
  location: string;

  /** The domain name to host internet services on. */
  domain: string;

  /** The GitHub repository that will be configured to deploy services. */
  githubRepo: `${string}/${string}`;

  /** The ID of the identity pool used to authenticate GitHub. Defaults to `github`. */
  githubIdentityPoolId?: string;

  /** The GitHub environment that is used to deploy services. Defaults to the suffix after `-` in the project ID. */
  githubEnvironment?: string;

  /**
   * The service account ID to of the Terraform viewer for the project. Defaults to `terraform-viewer`.
   * Certain additional permissions will be added to it that are not included in the default `Viewer` role.
   */
  terraformViewerServiceAccountId?: string;

  /** The google-beta provider to use to provision beta configuration of GCP projects. */
  googleBeta: TerraformProvider;
}

export class CurioStack extends Construct {
  /** The project provisioned by CurioStack. */
  public readonly project: string;

  /** The docker repository created for pushing application images to. */
  public readonly dockerRepository: ArtifactRegistryRepository;

  /** A virtual repository for accessing images on ghcr.io. */
  public readonly ghcrRepository: ArtifactRegistryRepository;

  /** The IAM membership string for the GitHub environment allowed to deploy to this project. */
  public readonly githubEnvironmentIamMember: string;

  /** The Cloud Run {@link ProjectService} for `dependsOn` of deployed cloud run services. */
  public readonly runService: ProjectService;

  constructor(scope: Construct, config: CurioStackConfig) {
    super(scope, "curiostack");

    this.project = config.project;

    const apps = new Apps(this, config);
    this.dockerRepository = apps.dockerRepository;
    this.ghcrRepository = apps.ghcrRepository;
    this.githubEnvironmentIamMember = apps.githubEnvironmentIamMember;
    this.runService = apps.runService;

    new Identity(this, config);
  }
}

class Apps extends Construct {
  public readonly dockerRepository: ArtifactRegistryRepository;
  public readonly ghcrRepository: ArtifactRegistryRepository;
  public readonly githubEnvironmentIamMember: string;
  public readonly runService: ProjectService;

  constructor(scope: Construct, config: CurioStackConfig) {
    super(scope, "apps");

    const artifactRegistryService = new ProjectService(
      this,
      "service-artifactregistry",
      {
        service: "artifactregistry.googleapis.com",
      },
    );

    this.runService = new ProjectService(this, "service-run", {
      service: "run.googleapis.com",
    });

    new ProjectService(this, "service-cloudtrace", {
      service: "cloudtrace.googleapis.com",
    });

    new ProjectService(this, "service-monitoring", {
      service: "monitoring.googleapis.com",
    });

    const deployerRole = new ProjectIamCustomRole(this, "cloudrun-deployer", {
      roleId: "cloudRunDeployer",
      title: "Cloud Run Deployer",
      permissions: [
        "run.operations.get",
        "run.services.create",
        "run.services.get",
        "run.services.update",
      ],
    });

    const githubIdPool = new DataGoogleIamWorkloadIdentityPool(
      this,
      "github-id-pool",
      {
        workloadIdentityPoolId: config.githubIdentityPoolId ?? "github",
        provider: config.googleBeta,
      },
    );

    if (!config.githubEnvironment && !config.project.includes("-")) {
      throw new Error(
        "project must include a `-` to determine the GitHub environment, or githubEnv must be provided",
      );
    }

    const githubEnv = config.githubEnvironment ?? config.project.split("-")[1];
    this.githubEnvironmentIamMember = `principal://iam.googleapis.com/${githubIdPool.name}/subject/repo:${config.githubRepo}:environment:${githubEnv}`;

    this.dockerRepository = new ArtifactRegistryRepository(
      this,
      "docker-registry",
      {
        repositoryId: "docker",
        location: config.location,
        format: "DOCKER",
        dependsOn: [artifactRegistryService],
      },
    );

    new ProjectIamMember(this, "github-cloudrun-deploy", {
      project: config.project,
      role: deployerRole.name,
      member: this.githubEnvironmentIamMember,
    });

    new ArtifactRegistryRepositoryIamMember(this, "docker-member-github", {
      repository: this.dockerRepository.name,
      location: this.dockerRepository.location,
      role: "roles/artifactregistry.writer",
      member: this.githubEnvironmentIamMember,
    });

    // CurioStack sometimes publishes images to ghcr and it is otherwise a fairly common repo that
    // cannot be accessed from cloud run by default. There's no harm in deploying a ghcr proxy
    // repository even if not used.
    this.ghcrRepository = new ArtifactRegistryRepository(this, "ghcr-repo", {
      repositoryId: "ghcr",
      location: config.location,
      format: "DOCKER",
      mode: "REMOTE_REPOSITORY",
      remoteRepositoryConfig: {
        dockerRepository: {
          customRepository: {
            uri: "https://ghcr.io",
          },
        },
      },

      dependsOn: [artifactRegistryService],
    });
  }
}

class Identity extends Construct {
  constructor(scope: Construct, config: CurioStackConfig) {
    super(scope, "identity");

    const service = new ProjectService(this, "identitytoolkit", {
      service: "identitytoolkit.googleapis.com",
    });

    new IdentityPlatformConfig(this, "identity-platform", {
      signIn: {
        // Enable email since it is almost always needed for integration tests or QA,
        // i.e., user+test123@domain.com.
        email: {
          enabled: true,
        },
      },
      authorizedDomains: [
        "localhost",
        config.domain,
        `${config.project}.web.app`,
        `${config.project}.firebaseapp.com`,
      ],
      dependsOn: [service],
    });

    // terraform-viewer account has Viewer role which cannot fetch firebase client secrets.
    // It has access to the values through terraform state so there is no additional permission
    // by providing access to the data in GCP when it refreshes.
    const secretViewerRole = new ProjectIamCustomRole(
      this,
      "firebaseauth-config-secret-viewer",
      {
        project: config.project,
        title: "Firebase Auth Config Secret Viewer",
        roleId: "firebaseauthConfigsSecretViewer",
        permissions: ["firebaseauth.configs.getSecret"],
      },
    );

    new ProjectIamMember(this, "terraform-viewer-firebase-secret", {
      project: config.project,
      role: secretViewerRole.name,
      member: `serviceAccount:${config.terraformViewerServiceAccountId ?? "terraform-viewer"}@${config.project}.iam.gserviceaccount.com`,
    });
  }
}
