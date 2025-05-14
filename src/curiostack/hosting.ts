import { GoogleFirebaseHostingCustomDomain } from "@cdktf/provider-google-beta/lib/google-firebase-hosting-custom-domain/index.js";
import { GoogleFirebaseHostingSite } from "@cdktf/provider-google-beta/lib/google-firebase-hosting-site/index.js";
import { GoogleFirebaseWebApp } from "@cdktf/provider-google-beta/lib/google-firebase-web-app/index.js";
import { ProjectIamCustomRole } from "@cdktf/provider-google/lib/project-iam-custom-role/index.js";
import { ProjectIamMember } from "@cdktf/provider-google/lib/project-iam-member/index.js";
import { ServiceAccountIamMember } from "@cdktf/provider-google/lib/service-account-iam-member/index.js";
import { ServiceAccount } from "@cdktf/provider-google/lib/service-account/index.js";
import { type ITerraformDependable, TerraformOutput } from "cdktf";
import { Construct } from "constructs";
import type { CurioStack } from "./index.js";

export interface CurioStackHostingConfig {
  /** A descriptive name of the website. */
  displayName: string;

  /** The {@link CurioStack} to configure the website with. */
  curiostack: CurioStack;

  dependsOn?: ITerraformDependable[];
}

export class CurioStackHosting extends Construct {
  constructor(scope: Construct, config: CurioStackHostingConfig) {
    super(scope, config.displayName.replace(" ", "-").toLowerCase());

    const { googleBeta, project } = config.curiostack.config;

    const webApp = new GoogleFirebaseWebApp(this, "web-app", {
      displayName: config.displayName,
      provider: googleBeta,
    });

    const site = new GoogleFirebaseHostingSite(this, "hosting-site", {
      appId: webApp.appId,
      siteId: project,
      provider: googleBeta,
    });

    const customDomain = new GoogleFirebaseHostingCustomDomain(
      this,
      "custom-domain",
      {
        siteId: site.siteId,
        customDomain: config.curiostack.config.domain,
        provider: googleBeta,
      },
    );

    new TerraformOutput(this, "custom-domain-dns-updates", {
      value: customDomain.requiredDnsUpdates,
    });

    // For forwarding to cloud run.
    const runViewerRole = new ProjectIamCustomRole(this, "cloudrun-deployer", {
      roleId: "cloudRunServiceViewer",
      title: "Cloud Run Service Viewer",
      permissions: ["run.services.get"],
    });

    // Firebase does not support direct workload identity,
    // so we need to create a service account to deploy.
    const firebaseDeployer = new ServiceAccount(this, "firebase-deployer", {
      accountId: "firebase-deployer",
    });

    new ProjectIamMember(this, "firebase-deployer-hosting-admin", {
      project: project,
      role: "roles/firebasehosting.admin",
      member: firebaseDeployer.member,
    });

    new ProjectIamMember(this, "firebase-deployer-cloudrun-viewer", {
      project: project,
      role: runViewerRole.name,
      member: firebaseDeployer.member,
    });

    new ServiceAccountIamMember(this, "github-firebase-deployer", {
      serviceAccountId: firebaseDeployer.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: config.curiostack.githubEnvironmentIamMember,
    });
  }
}
