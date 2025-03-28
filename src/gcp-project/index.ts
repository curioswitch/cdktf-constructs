import { GoogleFirebaseProject } from "@cdktf/provider-google-beta/lib/google-firebase-project/index.js";
import type { GoogleBetaProvider } from "@cdktf/provider-google-beta/lib/provider/index.js";
import { DataGoogleIamTestablePermissions } from "@cdktf/provider-google/lib/data-google-iam-testable-permissions/index.js";
import { IamWorkloadIdentityPoolProvider } from "@cdktf/provider-google/lib/iam-workload-identity-pool-provider/index.js";
import { IamWorkloadIdentityPool } from "@cdktf/provider-google/lib/iam-workload-identity-pool/index.js";
import { KmsCryptoKeyIamMember } from "@cdktf/provider-google/lib/kms-crypto-key-iam-member/index.js";
import { KmsCryptoKey } from "@cdktf/provider-google/lib/kms-crypto-key/index.js";
import { KmsKeyRing } from "@cdktf/provider-google/lib/kms-key-ring/index.js";
import { ProjectIamCustomRole } from "@cdktf/provider-google/lib/project-iam-custom-role/index.js";
import { ProjectIamMember } from "@cdktf/provider-google/lib/project-iam-member/index.js";
import { ProjectService } from "@cdktf/provider-google/lib/project-service/index.js";
import { Project } from "@cdktf/provider-google/lib/project/index.js";
import { ServiceAccountIamMember } from "@cdktf/provider-google/lib/service-account-iam-member/index.js";
import { ServiceAccount } from "@cdktf/provider-google/lib/service-account/index.js";
import { StorageBucketIamMember } from "@cdktf/provider-google/lib/storage-bucket-iam-member/index.js";
import { StorageBucket } from "@cdktf/provider-google/lib/storage-bucket/index.js";
import {
  Fn,
  type ITerraformDependable,
  TerraformIterator,
  TerraformOutput,
  type TerraformProvider,
} from "cdktf";
import { Construct } from "constructs";

/** Configuration of a {@link GcpProject}. */
export interface GcpProjectConfig {
  /** The project ID for the resulting project. Must be globally unique. */
  projectId: string;

  /** The display name of the project. If not set, will use projectId. */
  displayName?: string;

  /**
   * The GCP organization ID for the resulting project. Can be fetched by
   * domain using DataGoogleOrganization.
   */
  organizationId: string;

  /**
   * The GCP billing account ID for the resulting project. Can be fetched by
   * display name using DataGoogleBillingAccount.
   */
  billingAccountId: string;

  /**
   * The GitHub repository that will manage infrastructure configuration and
   * deploy using GitHub actions, in the format owner/repo.
   */
  githubInfraRepo: `${string}/${string}`;

  /**
   * The GitHub environment to allow deployment to this project. Generally
   * corresponds to the suffix of the project, e.g. "dev" for a project named
   * "my-project-dev".
   */
  githubEnvironment: string;

  /**
   * The GCS storage location for Terraform state, defaults to 'US'.
   * Terraform state is quite small and loaded / stored once per operation.
   */
  terraformStateLocation?: string;

  /**
   * The {@link GoogleBetaProvider} to use for enabling beta features in the
   * project.
   */
  googleBeta: TerraformProvider;

  /**
   * Any dependencies that should complete before project creation.
   */
  dependsOn?: ITerraformDependable[];
}

/**
 * A GCP project with common configurations for GitHub Actions and Terraform.
 */
export class GcpProject extends Construct {
  /** The created {@link Project}. */
  public readonly project: Project;

  /**
   * The GCS bucket name to hold Terraform state for this project.
   * Note, there is no way to automatically provision this bucket with a remote backend,
   * so we always first use local state and then migrate. This bucket name is returned as
   * a raw string for convenience but is not meant to be a dependency - it only is useful
   * as the value to {@link GcsBackend}.
   */
  public readonly tfstateBucketName: string;

  /** The created proejct service for cloud DNS to allow provisioning domains during bootstrap. */
  public readonly dnsService: ProjectService;

  /** The created {@link IamWorkloadIdentityPool} for authenticating from GitHub actions. */
  public readonly githubIdentityPool: IamWorkloadIdentityPool;

  /** The created {@link ServiceAccount} for applying changes with Terraform. */
  public readonly terraformAdminServiceAccount: ServiceAccount;

  /** The created {@link ServiceAccount} for planning changes with Terraform. */
  public readonly terraformViewerServiceAccount: ServiceAccount;

  /** The created {@link KmsKeyRing} for storing Terraform keys. */
  public readonly terraformKeyring: KmsKeyRing;

  /** The created {@link KmsCryptoKey} for encrypting Terraform secrets. */
  public readonly terraformSecretsKey: KmsCryptoKey;

  constructor(scope: Construct, config: GcpProjectConfig) {
    super(scope, config.projectId);

    this.project = new Project(this, "this", {
      projectId: config.projectId,
      name: config.displayName ?? config.projectId,
      orgId: config.organizationId,
      billingAccount: config.billingAccountId,
      labels: {
        firebase: "enabled",
      },
      dependsOn: config.dependsOn,
    });

    new GoogleFirebaseProject(this, "firebase", {
      project: this.project.projectId,
      provider: config.googleBeta,
    });

    const tfstateBucket = new StorageBucket(this, "tfstate", {
      project: this.project.projectId,
      name: `${this.project.projectId}-tfstate`,
      location: config.terraformStateLocation ?? "US",
      storageClass: "STANDARD",
      versioning: {
        enabled: true,
      },
    });
    this.tfstateBucketName = `${config.projectId}-tfstate`;

    // Commonly needed for executing certain Terraform actions with
    // a user account.
    new ProjectService(this, "resourcemanager", {
      project: this.project.projectId,
      service: "cloudresourcemanager.googleapis.com",
    });

    this.dnsService = new ProjectService(this, "dns", {
      project: this.project.projectId,
      service: "dns.googleapis.com",
    });

    const iam = new ProjectService(this, "iam", {
      project: this.project.projectId,
      service: "iam.googleapis.com",
    });

    // TODO: Dependencies seem fine but there seems to be a lag between project creation
    // and being able to create this. Executing apply twice for each project currently
    // is the workaround.
    this.githubIdentityPool = new IamWorkloadIdentityPool(
      this,
      "github-id-pool",
      {
        project: this.project.projectId,
        workloadIdentityPoolId: "github",
        dependsOn: [iam],
      },
    );

    const orgName = config.githubInfraRepo.split("/")[0];

    const idProvider = new IamWorkloadIdentityPoolProvider(
      this,
      "github-id-provider",
      {
        project: this.project.projectId,
        workloadIdentityPoolProviderId: "github",
        workloadIdentityPoolId: this.githubIdentityPool.workloadIdentityPoolId,
        attributeMapping: {
          "google.subject": "assertion.sub",
          "attribute.actor": "assertion.actor",
          "attribute.repository": "assertion.repository",
          "attribute.repository_owner": "assertion.repository_owner",
        },
        attributeCondition: `assertion.repository_owner == '${orgName}'`,
        oidc: {
          issuerUri: "https://token.actions.githubusercontent.com",
        },
      },
    );

    new TerraformOutput(this, `github-identity-provider-${config.projectId}`, {
      staticId: true,
      value: idProvider.name,
    });

    const kmsService = new ProjectService(this, "kms-service", {
      project: this.project.projectId,
      service: "cloudkms.googleapis.com",
    });

    this.terraformKeyring = new KmsKeyRing(this, "terraform-keyring", {
      project: this.project.projectId,
      name: "terraform",
      location: "global",
      dependsOn: [kmsService],
    });

    this.terraformSecretsKey = new KmsCryptoKey(this, "terraform-key", {
      keyRing: this.terraformKeyring.id,
      name: "secrets",
    });

    this.terraformAdminServiceAccount = new ServiceAccount(
      this,
      "terraform-admin",
      {
        project: this.project.projectId,
        accountId: "terraform-admin",
      },
    );

    new ProjectIamMember(this, "terraform-admin-owner", {
      project: this.project.projectId,
      role: "roles/owner",
      member: this.terraformAdminServiceAccount.member,
    });

    new ServiceAccountIamMember(this, "terraform-admin-github-actions", {
      serviceAccountId: this.terraformAdminServiceAccount.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: `principal://iam.googleapis.com/${this.githubIdentityPool.name}/subject/repo:${config.githubInfraRepo}:environment:${config.githubEnvironment}`,
    });

    this.terraformViewerServiceAccount = new ServiceAccount(
      this,
      "terraform-viewer",
      {
        project: this.project.projectId,
        accountId: "terraform-viewer",
      },
    );

    new ProjectIamMember(this, "terraform-viewer-viewer", {
      project: this.project.projectId,
      role: "roles/viewer",
      member: this.terraformViewerServiceAccount.member,
    });

    new ProjectIamMember(this, "terraform-viewer-serviceUser", {
      project: this.project.projectId,
      role: "roles/serviceusage.serviceUsageConsumer",
      member: this.terraformViewerServiceAccount.member,
    });

    new KmsCryptoKeyIamMember(this, "terraform-viewer-key-decrypter", {
      cryptoKeyId: this.terraformSecretsKey.id,
      role: "roles/cloudkms.cryptoOperator",
      member: this.terraformViewerServiceAccount.member,
    });

    new ProjectIamMember(this, "terraform-viewer-key-secretaccess", {
      project: this.project.projectId,
      role: "roles/secretmanager.secretAccessor",
      member: this.terraformViewerServiceAccount.member,
    });

    new ServiceAccountIamMember(this, "terraform-viewer-github-actions", {
      serviceAccountId: this.terraformViewerServiceAccount.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: `principal://iam.googleapis.com/${this.githubIdentityPool.name}/subject/repo:${config.githubInfraRepo}:environment:${config.githubEnvironment}-viewer`,
    });

    // getIamPolicy not provided to viewer but commonly used in terraform plans. We can easily dynamically create a role for it.
    const testablePermissions = new DataGoogleIamTestablePermissions(
      this,
      "gcp-testable-permissions",
      {
        fullResourceName: `//cloudresourcemanager.googleapis.com/projects/${this.project.projectId}`,
        stages: ["GA", "BETA"],
      },
    );

    const iamPolicyViewerRole = new ProjectIamCustomRole(
      this,
      "iam-policy-viewer",
      {
        roleId: "iamPolicyViewer",
        title: "IAM Policy Viewer",
        project: this.project.projectId,
        permissions: TerraformIterator.fromList(
          testablePermissions.permissions,
        ).forExpressionForList(
          'val.name if endswith(val.name, ".getIamPolicy")',
        ) as unknown as string[], // Type definnition not correct
      },
    );

    new ProjectIamMember(this, "terraform-viewer-iam-policy-viewer", {
      project: this.project.projectId,
      role: iamPolicyViewerRole.name,
      member: this.terraformViewerServiceAccount.member,
    });

    // Need write permission to the state to take lock. While ideally we may use a different bucket, but
    // there is no such option. Generally we use permissions to protect against access to the infrastructure
    // itself and not the state so this is probably acceptable.
    new StorageBucketIamMember(this, "terraform-viewer-tfstate", {
      bucket: tfstateBucket.name,
      role: "roles/storage.objectUser",
      member: this.terraformViewerServiceAccount.member,
    });
  }
}
