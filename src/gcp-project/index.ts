import { GoogleFirebaseProject } from "@cdktf/provider-google-beta/lib/google-firebase-project";
import type { GoogleBetaProvider } from "@cdktf/provider-google-beta/lib/provider";
import { IamWorkloadIdentityPool } from "@cdktf/provider-google/lib/iam-workload-identity-pool";
import { IamWorkloadIdentityPoolProvider } from "@cdktf/provider-google/lib/iam-workload-identity-pool-provider";
import { KmsCryptoKey } from "@cdktf/provider-google/lib/kms-crypto-key";
import { KmsCryptoKeyIamMember } from "@cdktf/provider-google/lib/kms-crypto-key-iam-member";
import { KmsKeyRing } from "@cdktf/provider-google/lib/kms-key-ring";
import { Project } from "@cdktf/provider-google/lib/project";
import { ProjectIamMember } from "@cdktf/provider-google/lib/project-iam-member";
import { ProjectService } from "@cdktf/provider-google/lib/project-service";
import { ServiceAccount } from "@cdktf/provider-google/lib/service-account";
import { ServiceAccountIamMember } from "@cdktf/provider-google/lib/service-account-iam-member";
import { StorageBucket } from "@cdktf/provider-google/lib/storage-bucket";
import { StorageBucketIamMember } from "@cdktf/provider-google/lib/storage-bucket-iam-member";
import {
  type ITerraformDependable,
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
   * The {@link GoogleBetaProvider} to use for enabling beta features in the
   * project.
   */
  googleBeta: TerraformProvider;

  /**
   * Any dependencies that should complete before project creation.
   */
  dependsOn?: ITerraformDependable[];
}

export class GcpProject extends Construct {
  public readonly project: Project;

  public readonly githubIdentityPool: IamWorkloadIdentityPool;
  public readonly terraformAdminServiceAccount: ServiceAccount;
  public readonly terraformViewerServiceAccount: ServiceAccount;

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

    const tfState = new StorageBucket(this, "tfstate", {
      project: this.project.projectId,
      name: `${this.project.projectId}-tfstate`,
      location: "US",
      storageClass: "STANDARD",
      versioning: {
        enabled: true,
      },
    });

    // Commonly needed for executing certain Terraform actions with
    // a user account.
    new ProjectService(this, "resourcemanager", {
      project: this.project.projectId,
      service: "cloudresourcemanager.googleapis.com",
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

    new TerraformOutput(this, "github-identity-provider", {
      staticId: true,
      value: idProvider.name,
    });

    const kmsService = new ProjectService(this, "kms-service", {
      project: this.project.projectId,
      service: "cloudkms.googleapis.com",
    });

    const keyring = new KmsKeyRing(this, "terraform-keyring", {
      project: this.project.projectId,
      name: "terraform",
      location: "global",
      dependsOn: [kmsService],
    });

    const terraformKey = new KmsCryptoKey(this, "terraform-key", {
      keyRing: keyring.id,
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
      cryptoKeyId: terraformKey.id,
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

    // Need write permission to the state to take lock. While ideally we may use a different bucket, but
    // there is no such option. Generally we use permissions to protect against access to the infrastructure
    // itself and not the state so this is probably acceptable.
    new StorageBucketIamMember(this, "terraform-viewer-tfstate", {
      bucket: tfState.name,
      role: "roles/storage.objectUser",
      member: this.terraformViewerServiceAccount.member,
    });
  }
}
