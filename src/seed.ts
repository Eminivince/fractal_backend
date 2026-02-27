import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import {
  ApplicationModel,
  AssetModel,
  BusinessModel,
  DistributionModel,
  DisputeModel,
  DossierModel,
  EventLogModel,
  IdempotencyKeyModel,
  AnchorModel,
  EscrowReceiptModel,
  LedgerEntryModel,
  ReconciliationRunModel,
  ReconciliationIssueModel,
  InvestorProfileModel,
  MilestoneModel,
  NotificationModel,
  OfferingModel,
  PlatformConfigModel,
  ProfessionalModel,
  SubscriptionModel,
  TaskModel,
  TemplateModel,
  TrancheModel,
  UserModel,
  CorporateActionModel,
} from "./db/models.js";
import { toDecimal } from "./utils/decimal.js";

function nowMinus(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function seed() {
  await connectMongo();

  const models = [
    EventLogModel,
    IdempotencyKeyModel,
    ReconciliationIssueModel,
    ReconciliationRunModel,
    LedgerEntryModel,
    EscrowReceiptModel,
    AnchorModel,
    CorporateActionModel,
    TrancheModel,
    MilestoneModel,
    DistributionModel,
    DisputeModel,
    SubscriptionModel,
    OfferingModel,
    TaskModel,
    DossierModel,
    ApplicationModel,
    AssetModel,
    ProfessionalModel,
    TemplateModel,
    PlatformConfigModel,
    InvestorProfileModel,
    NotificationModel,
    UserModel,
    BusinessModel,
  ];

  for (const model of models) {
    await model.deleteMany({});
  }

  const demoPasswordHash = await bcrypt.hash("Demo1234!", 12);

  // ── Businesses ──────────────────────────────────────────────────────────────
  const [businessOne, businessTwo] = await BusinessModel.create([
    {
      name: "Bluebrick Estates Ltd",
      type: "property_owner",
      kybStatus: "approved",
      riskTier: "medium",
      status: "active",
      createdAt: nowMinus(120),
      updatedAt: nowMinus(120),
    },
    {
      name: "Northfield Developments",
      type: "developer",
      kybStatus: "approved",
      riskTier: "high",
      status: "active",
      createdAt: nowMinus(110),
      updatedAt: nowMinus(110),
    },
  ]);

  // ── Professionals ────────────────────────────────────────────────────────────
  const [inspectorProf, valuerProf, lawyerProf] = await ProfessionalModel.create([
    {
      category: "inspector",
      name: "Ade Inspection Ltd",
      regions: ["Lagos", "Abuja"],
      slaDays: 3,
      pricing: { model: "flat", amount: toDecimal(250000) },
      onboardingStatus: "approved",
      contactEmail: "inspector1@fractal.demo",
      status: "active",
      createdAt: nowMinus(90),
      updatedAt: nowMinus(90),
    },
    {
      category: "valuer",
      name: "Prime Valuations",
      regions: ["Lagos"],
      slaDays: 5,
      pricing: { model: "flat", amount: toDecimal(300000) },
      onboardingStatus: "approved",
      contactEmail: "valuer1@fractal.demo",
      status: "active",
      createdAt: nowMinus(88),
      updatedAt: nowMinus(88),
    },
    {
      category: "lawyer",
      name: "Chambers & Co",
      regions: ["Nationwide"],
      slaDays: 7,
      pricing: { model: "flat", amount: toDecimal(450000) },
      onboardingStatus: "approved",
      contactEmail: "lawyer1@fractal.demo",
      status: "active",
      createdAt: nowMinus(85),
      updatedAt: nowMinus(85),
    },
  ]);

  // ── Users ────────────────────────────────────────────────────────────────────
  const [
    admin,
    operator,
    operator2,
    issuerOne,
    issuerTwo,
    inv1,
    inv2,
    inv3,
    inv4,
    inv5,
    inv6,
    inspectorUser,
    valuerUser,
    lawyerUser,
  ] = await UserModel.create([
    {
      email: "admin@fractal.demo",
      name: "Platform Admin",
      role: "admin",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(200),
      updatedAt: nowMinus(200),
    },
    {
      email: "operator@fractal.demo",
      name: "Review Operator",
      role: "operator",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(180),
      updatedAt: nowMinus(180),
    },
    {
      email: "operator2@fractal.demo",
      name: "Senior Operator",
      role: "operator",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(170),
      updatedAt: nowMinus(170),
    },
    {
      email: "issuer1@fractal.demo",
      name: "Bluebrick Issuer",
      role: "issuer",
      businessId: businessOne._id,
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(160),
      updatedAt: nowMinus(160),
    },
    {
      email: "issuer2@fractal.demo",
      name: "Northfield Issuer",
      role: "issuer",
      businessId: businessTwo._id,
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(150),
      updatedAt: nowMinus(150),
    },
    {
      email: "investor1@fractal.demo",
      name: "Amara Osei",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(140),
      updatedAt: nowMinus(140),
    },
    {
      email: "investor2@fractal.demo",
      name: "Kwame Mensah",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(130),
      updatedAt: nowMinus(130),
    },
    {
      email: "investor3@fractal.demo",
      name: "Fatima Bello",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(120),
      updatedAt: nowMinus(120),
    },
    {
      email: "investor4@fractal.demo",
      name: "Emeka Nwosu",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(110),
      updatedAt: nowMinus(110),
    },
    {
      email: "investor5@fractal.demo",
      name: "Chidinma Eze",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(100),
      updatedAt: nowMinus(100),
    },
    {
      email: "investor6@fractal.demo",
      name: "Segun Adeyemi",
      role: "investor",
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(95),
      updatedAt: nowMinus(95),
    },
    {
      email: "inspector1@fractal.demo",
      name: "Ade Inspection Ltd",
      role: "professional",
      professionalId: inspectorProf._id,
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(90),
      updatedAt: nowMinus(90),
    },
    {
      email: "valuer1@fractal.demo",
      name: "Prime Valuations",
      role: "professional",
      professionalId: valuerProf._id,
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(88),
      updatedAt: nowMinus(88),
    },
    {
      email: "lawyer1@fractal.demo",
      name: "Chambers & Co",
      role: "professional",
      professionalId: lawyerProf._id,
      status: "active",
      passwordHash: demoPasswordHash,
      createdAt: nowMinus(85),
      updatedAt: nowMinus(85),
    },
  ]);

  // ── Investor Profiles ────────────────────────────────────────────────────────
  // inv1: KYC approved, high eligibility
  const profile1 = await InvestorProfileModel.create({
    userId: inv1._id,
    kycStatus: "approved",
    eligibility: "sophisticated",
    documents: [],
    createdAt: nowMinus(135),
    updatedAt: nowMinus(100),
  });
  inv1.investorProfileId = profile1._id;
  await inv1.save();

  // inv2: KYC approved, retail
  const profile2 = await InvestorProfileModel.create({
    userId: inv2._id,
    kycStatus: "approved",
    eligibility: "retail",
    documents: [],
    createdAt: nowMinus(125),
    updatedAt: nowMinus(95),
  });
  inv2.investorProfileId = profile2._id;
  await inv2.save();

  // inv3: KYC in_review
  const profile3 = await InvestorProfileModel.create({
    userId: inv3._id,
    kycStatus: "in_review",
    eligibility: "retail",
    documents: [],
    createdAt: nowMinus(115),
    updatedAt: nowMinus(80),
  });
  inv3.investorProfileId = profile3._id;
  await inv3.save();

  // inv4: KYC draft (incomplete)
  const profile4 = await InvestorProfileModel.create({
    userId: inv4._id,
    kycStatus: "draft",
    eligibility: "retail",
    documents: [],
    createdAt: nowMinus(105),
    updatedAt: nowMinus(105),
  });
  inv4.investorProfileId = profile4._id;
  await inv4.save();

  // inv5: KYC approved, subscribed to both offerings
  const profile5 = await InvestorProfileModel.create({
    userId: inv5._id,
    kycStatus: "approved",
    eligibility: "retail",
    documents: [],
    createdAt: nowMinus(98),
    updatedAt: nowMinus(70),
  });
  inv5.investorProfileId = profile5._id;
  await inv5.save();

  // inv6: KYC rejected (edge case)
  const profile6 = await InvestorProfileModel.create({
    userId: inv6._id,
    kycStatus: "rejected",
    eligibility: "retail",
    documents: [],
    createdAt: nowMinus(90),
    updatedAt: nowMinus(60),
  });
  inv6.investorProfileId = profile6._id;
  await inv6.save();

  // ── Platform Config ──────────────────────────────────────────────────────────
  await PlatformConfigModel.create({
    _id: "platform_config",
    featureFlags: {
      enableTemplateB: true,
      enableStablecoinPayouts: false,
      enableSecondaryTransfers: false,
    },
    complianceRules: {
      requireKycToView: false,
      requireKycToSubscribe: true,
      transferModeDefault: "whitelist",
      defaultLockupDays: 90,
      minInvestmentByTemplate: {
        A: toDecimal(500000),
        B: toDecimal(1000000),
      },
    },
    feeConfig: {
      setupFee: toDecimal(500000),
      platformFeePct: toDecimal(2),
      servicingFeePct: toDecimal(1),
    },
    contentConfig: {
      heroHeadline: "Tokenization infrastructure for African real assets",
      heroSubtext:
        "From origination to distributions, Fractal gives issuers, investors, and operators a shared operational layer for compliant on-chain and off-chain asset programs.",
      ctas: ["Issuer Portal", "Investor Portal", "Operator Console"],
      howItWorks: [
        "Application Intake",
        "Asset Diligence",
        "Structuring",
        "Compliance Review",
        "Offering Issuance",
        "Investor Subscriptions",
        "Servicing & Distributions",
        "Exit & Reporting",
      ],
      faqs: [
        {
          q: "Is this live for production investment?",
          a: "Not yet. This environment is intended for sandbox workflow validation.",
        },
        {
          q: "Which products are supported?",
          a: "Rental Yield Notes and Developer Inventory Financing templates are supported.",
        },
        {
          q: "How are compliance controls handled?",
          a: "Rules are configured in the admin console and enforced in route-level views.",
        },
      ],
    },
    updatedBy: admin._id,
    updatedAt: nowMinus(10),
  });

  // ── Templates ────────────────────────────────────────────────────────────────
  await TemplateModel.create([
    {
      code: "A",
      name: "Rental Yield Notes",
      checklistItems: [
        { key: "title_deed", label: "Title Deed", requiredStage: "Intake" },
        { key: "rent_roll", label: "Rent Roll", requiredStage: "Intake" },
        { key: "valuation_report", label: "Valuation Report", requiredStage: "Diligence" },
      ],
      termSchema: [
        { key: "raiseAmount", label: "Raise Amount", type: "number", required: true },
        { key: "minTicket", label: "Min Ticket", type: "number", required: true },
        { key: "durationMonths", label: "Duration", type: "number", required: true },
        { key: "targetYieldPct", label: "Target Yield", type: "number", required: true },
      ],
      enabled: true,
      updatedBy: admin._id,
      updatedAt: nowMinus(10),
    },
    {
      code: "B",
      name: "Developer Inventory Financing",
      checklistItems: [
        { key: "land_title", label: "Land Title", requiredStage: "Intake" },
        { key: "boq", label: "Bill of Quantities", requiredStage: "Intake" },
        { key: "project_timeline", label: "Project Timeline", requiredStage: "Structuring" },
      ],
      termSchema: [
        { key: "raiseAmount", label: "Raise Amount", type: "number", required: true },
        { key: "minTicket", label: "Min Ticket", type: "number", required: true },
        { key: "durationMonths", label: "Duration", type: "number", required: true },
        {
          key: "repaymentType",
          label: "Repayment Type",
          type: "enum",
          required: true,
          options: ["milestone", "inventory"],
        },
      ],
      enabled: true,
      updatedBy: admin._id,
      updatedAt: nowMinus(10),
    },
  ]);

  // ── Assets ───────────────────────────────────────────────────────────────────
  const [assetA, assetB, assetC] = await AssetModel.create([
    {
      businessId: businessOne._id,
      type: "real_estate",
      name: "Lekki Apartment Block",
      location: { country: "Nigeria", state: "Lagos", city: "Lekki", addressLine: "Admiralty Way" },
      summary: "10-unit rental property generating consistent monthly income since 2021.",
      createdAt: nowMinus(40),
      updatedAt: nowMinus(40),
    },
    {
      businessId: businessTwo._id,
      type: "real_estate",
      name: "Abuja Terrace Development Phase 1",
      location: { country: "Nigeria", state: "FCT", city: "Abuja", addressLine: "Maitama District" },
      summary: "20-unit terrace development targeting high-income buyers in Maitama.",
      createdAt: nowMinus(38),
      updatedAt: nowMinus(38),
    },
    {
      businessId: businessOne._id,
      type: "real_estate",
      name: "VI Commercial Plaza",
      location: { country: "Nigeria", state: "Lagos", city: "Victoria Island", addressLine: "Adeola Odeku Street" },
      summary: "Mixed-use commercial plaza with office and retail spaces. Application in review.",
      createdAt: nowMinus(10),
      updatedAt: nowMinus(10),
    },
  ]);

  // ── Applications ─────────────────────────────────────────────────────────────
  // App A: approved → has offering
  const applicationA = await ApplicationModel.create({
    businessId: businessOne._id,
    templateCode: "A",
    assetId: assetA._id,
    stage: "Compliance",
    status: "approved",
    checklistState: [
      { key: "title_deed", label: "Title Deed", stage: "Intake", required: true, status: "verified" },
      { key: "rent_roll", label: "Rent Roll", stage: "Intake", required: true, status: "verified" },
      { key: "valuation_report", label: "Valuation Report", stage: "Diligence", required: true, status: "verified" },
    ],
    createdBy: issuerOne._id,
    submittedAt: nowMinus(34),
    approvedAt: nowMinus(30),
    createdAt: nowMinus(35),
    updatedAt: nowMinus(30),
  });

  // App B: approved → has offering
  const applicationB = await ApplicationModel.create({
    businessId: businessTwo._id,
    templateCode: "B",
    assetId: assetB._id,
    stage: "Compliance",
    status: "approved",
    checklistState: [
      { key: "land_title", label: "Land Title", stage: "Intake", required: true, status: "verified" },
      { key: "boq", label: "Bill of Quantities", stage: "Intake", required: true, status: "verified" },
      { key: "project_timeline", label: "Project Timeline", stage: "Structuring", required: true, status: "verified" },
    ],
    milestones: [
      { name: "Foundation", percent: 20, targetDate: nowMinus(-7) },
      { name: "Framing", percent: 20, targetDate: nowMinus(-15) },
      { name: "Roofing", percent: 20, targetDate: nowMinus(-22) },
      { name: "Finishing", percent: 25, targetDate: nowMinus(-30) },
      { name: "Handover", percent: 15, targetDate: nowMinus(-40) },
    ],
    createdBy: issuerTwo._id,
    submittedAt: nowMinus(33),
    approvedAt: nowMinus(28),
    createdAt: nowMinus(34),
    updatedAt: nowMinus(28),
  });

  // App C: in_review / pending (no offering yet — for operator review UI)
  const applicationC = await ApplicationModel.create({
    businessId: businessOne._id,
    templateCode: "A",
    assetId: assetC._id,
    stage: "Diligence",
    status: "in_review",
    checklistState: [
      { key: "title_deed", label: "Title Deed", stage: "Intake", required: true, status: "verified" },
      { key: "rent_roll", label: "Rent Roll", stage: "Intake", required: true, status: "provided" },
      { key: "valuation_report", label: "Valuation Report", stage: "Diligence", required: true, status: "provided" },
    ],
    createdBy: issuerOne._id,
    submittedAt: nowMinus(5),
    createdAt: nowMinus(7),
    updatedAt: nowMinus(3),
  });

  // ── Dossiers ─────────────────────────────────────────────────────────────────
  await DossierModel.create([
    {
      applicationId: applicationA._id,
      structuredData: { occupancyRate: 0.9, monthlyGrossRent: 4200000 },
      documents: [
        {
          type: "Title Deed",
          filename: "lekki-title-deed.pdf",
          storageKey: "seed://a/title-deed.pdf",
          uploadedBy: issuerOne._id,
          uploadedAt: nowMinus(34),
          stageTag: "Intake",
        },
        {
          type: "Rent Roll",
          filename: "lekki-rent-roll.xlsx",
          storageKey: "seed://a/rent-roll.xlsx",
          uploadedBy: issuerOne._id,
          uploadedAt: nowMinus(34),
          stageTag: "Intake",
        },
        {
          type: "Valuation Report",
          filename: "lekki-valuation.pdf",
          storageKey: "seed://a/valuation.pdf",
          uploadedBy: issuerOne._id,
          uploadedAt: nowMinus(32),
          stageTag: "Diligence",
        },
      ],
      hashes: [{ algo: "sha256", hash: "hash-app-a", createdAt: nowMinus(34) }],
    },
    {
      applicationId: applicationB._id,
      structuredData: { units: 20, location: "Abuja" },
      documents: [
        {
          type: "Land Title",
          filename: "abuja-land-title.pdf",
          storageKey: "seed://b/land-title.pdf",
          uploadedBy: issuerTwo._id,
          uploadedAt: nowMinus(33),
          stageTag: "Intake",
        },
        {
          type: "Bill of Quantities",
          filename: "abuja-boq.pdf",
          storageKey: "seed://b/boq.pdf",
          uploadedBy: issuerTwo._id,
          uploadedAt: nowMinus(33),
          stageTag: "Intake",
        },
        {
          type: "Project Timeline",
          filename: "abuja-timeline.xlsx",
          storageKey: "seed://b/timeline.xlsx",
          uploadedBy: issuerTwo._id,
          uploadedAt: nowMinus(31),
          stageTag: "Structuring",
        },
      ],
      hashes: [{ algo: "sha256", hash: "hash-app-b", createdAt: nowMinus(33) }],
    },
    {
      applicationId: applicationC._id,
      structuredData: { floors: 8, commercialUnits: 12 },
      documents: [
        {
          type: "Title Deed",
          filename: "vi-plaza-title.pdf",
          storageKey: "seed://c/title-deed.pdf",
          uploadedBy: issuerOne._id,
          uploadedAt: nowMinus(6),
          stageTag: "Intake",
        },
      ],
      hashes: [{ algo: "sha256", hash: "hash-app-c", createdAt: nowMinus(6) }],
    },
  ]);

  // ── Work Orders (Tasks) ───────────────────────────────────────────────────────
  // App A: 3 completed tasks
  await TaskModel.create([
    {
      applicationId: applicationA._id,
      stage: "Diligence",
      category: "inspection",
      assignedProfessionalId: inspectorProf._id,
      assignedAt: nowMinus(33),
      status: "completed",
      slaDays: 3,
      evidenceDocs: [{ docId: "e1", filename: "inspection-report.pdf" }],
      completedAt: nowMinus(31),
      createdAt: nowMinus(33),
      updatedAt: nowMinus(31),
    },
    {
      applicationId: applicationA._id,
      stage: "Diligence",
      category: "valuation",
      assignedProfessionalId: valuerProf._id,
      assignedAt: nowMinus(33),
      status: "completed",
      slaDays: 5,
      evidenceDocs: [{ docId: "e2", filename: "valuation-report.pdf" }],
      completedAt: nowMinus(30),
      createdAt: nowMinus(33),
      updatedAt: nowMinus(30),
    },
    {
      applicationId: applicationA._id,
      stage: "Structuring",
      category: "legal",
      assignedProfessionalId: lawyerProf._id,
      assignedAt: nowMinus(32),
      status: "completed",
      slaDays: 7,
      evidenceDocs: [{ docId: "e3", filename: "legal-opinion.pdf" }],
      completedAt: nowMinus(29),
      createdAt: nowMinus(32),
      updatedAt: nowMinus(29),
    },
    // App B: 2 tasks (one completed, one in_progress)
    {
      applicationId: applicationB._id,
      stage: "Diligence",
      category: "inspection",
      assignedProfessionalId: inspectorProf._id,
      assignedAt: nowMinus(32),
      status: "completed",
      slaDays: 3,
      evidenceDocs: [{ docId: "e4", filename: "abuja-inspection.pdf" }],
      completedAt: nowMinus(29),
      createdAt: nowMinus(32),
      updatedAt: nowMinus(29),
    },
    {
      applicationId: applicationB._id,
      stage: "Structuring",
      category: "legal",
      assignedProfessionalId: lawyerProf._id,
      assignedAt: nowMinus(20),
      status: "in_progress",
      slaDays: 7,
      evidenceDocs: [],
      createdAt: nowMinus(20),
      updatedAt: nowMinus(5),
    },
    // App C: 1 open task
    {
      applicationId: applicationC._id,
      stage: "Diligence",
      category: "valuation",
      assignedProfessionalId: valuerProf._id,
      assignedAt: nowMinus(3),
      status: "open",
      slaDays: 5,
      evidenceDocs: [],
      createdAt: nowMinus(3),
      updatedAt: nowMinus(3),
    },
  ]);

  // ── Offerings ────────────────────────────────────────────────────────────────
  const [offeringA, offeringB] = await OfferingModel.create([
    {
      applicationId: applicationA._id,
      businessId: businessOne._id,
      templateCode: "A",
      name: "Lekki Rental Yield Note Series A",
      summary: "Monthly rental-backed payouts from prime Lekki apartments",
      status: "open",
      opensAt: nowMinus(20),
      closesAt: nowMinus(-20),
      terms: {
        returnType: "fixed",
        raiseAmount: 50000000,
        minTicket: 500000,
        durationMonths: 24,
        targetYieldPct: 18,
        distributionFrequency: "monthly",
        reserveRatioPct: 10,
        fees: { setupFee: 500000, platformFeePct: 2, servicingFeePct: 1 },
      },
      feeSnapshot: {
        setupFee: toDecimal(500000),
        platformFeePct: toDecimal(2),
        servicingFeePct: toDecimal(1),
      },
      metrics: {
        raiseAmount: toDecimal(50000000),
        subscribedAmount: toDecimal(18000000),
        investorCount: 4,
      },
      createdBy: issuerOne._id,
      createdAt: nowMinus(18),
      updatedAt: nowMinus(2),
    },
    {
      applicationId: applicationB._id,
      businessId: businessTwo._id,
      templateCode: "B",
      name: "Abuja Developer Inventory Note I",
      summary: "Milestone-based inventory financing for Abuja terrace units",
      status: "open",
      opensAt: nowMinus(14),
      closesAt: nowMinus(-30),
      terms: {
        returnType: "fixed",
        raiseAmount: 120000000,
        minTicket: 1000000,
        durationMonths: 18,
        repaymentType: "milestone",
        milestones: [
          { name: "Foundation", percent: 20 },
          { name: "Framing", percent: 20 },
          { name: "Roofing", percent: 20 },
          { name: "Finishing", percent: 25 },
          { name: "Handover", percent: 15 },
        ],
        trancheRules: "Release tranche when operator verifies evidence",
        fees: { setupFee: 500000, platformFeePct: 2, servicingFeePct: 1 },
      },
      feeSnapshot: {
        setupFee: toDecimal(500000),
        platformFeePct: toDecimal(2),
        servicingFeePct: toDecimal(1),
      },
      metrics: {
        raiseAmount: toDecimal(120000000),
        subscribedAmount: toDecimal(22000000),
        investorCount: 3,
      },
      createdBy: issuerTwo._id,
      createdAt: nowMinus(13),
      updatedAt: nowMinus(2),
    },
  ]);

  // ── Subscriptions ─────────────────────────────────────────────────────────────
  const subscriptions = await SubscriptionModel.create([
    {
      offeringId: offeringA._id,
      investorUserId: inv1._id,
      amount: toDecimal(5000000),
      status: "paid",
      createdAt: nowMinus(15),
      updatedAt: nowMinus(12),
    },
    {
      offeringId: offeringA._id,
      investorUserId: inv2._id,
      amount: toDecimal(2000000),
      status: "committed",
      createdAt: nowMinus(14),
      updatedAt: nowMinus(14),
    },
    {
      offeringId: offeringA._id,
      investorUserId: inv5._id,
      amount: toDecimal(6000000),
      status: "paid",
      createdAt: nowMinus(13),
      updatedAt: nowMinus(10),
    },
    {
      offeringId: offeringA._id,
      investorUserId: inv1._id,
      amount: toDecimal(5000000),
      status: "paid",
      createdAt: nowMinus(12),
      updatedAt: nowMinus(9),
    },
    {
      offeringId: offeringB._id,
      investorUserId: inv1._id,
      amount: toDecimal(8000000),
      status: "paid",
      createdAt: nowMinus(11),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      investorUserId: inv5._id,
      amount: toDecimal(4000000),
      status: "committed",
      createdAt: nowMinus(9),
      updatedAt: nowMinus(9),
    },
    {
      offeringId: offeringB._id,
      investorUserId: inv2._id,
      amount: toDecimal(10000000),
      status: "payment_pending",
      createdAt: nowMinus(6),
      updatedAt: nowMinus(6),
    },
  ]);

  // ── Distributions ─────────────────────────────────────────────────────────────
  const [distributionA1, distributionA2] = await DistributionModel.create([
    {
      offeringId: offeringA._id,
      period: "2026-01",
      amount: toDecimal(900000),
      status: "paid",
      createdBy: issuerOne._id,
      approvedBy: operator._id,
      createdAt: nowMinus(28),
      updatedAt: nowMinus(25),
    },
    {
      offeringId: offeringA._id,
      period: "2026-03",
      amount: toDecimal(1200000),
      status: "scheduled",
      createdBy: issuerOne._id,
      approvedBy: operator._id,
      createdAt: nowMinus(2),
      updatedAt: nowMinus(1),
    },
  ]);

  // ── Milestones ────────────────────────────────────────────────────────────────
  const milestoneDocs = await MilestoneModel.create([
    {
      offeringId: offeringB._id,
      name: "Foundation",
      percent: 20,
      status: "verified",
      evidenceDocs: [{ docId: "m1", filename: "foundation-evidence.pdf" }],
      verifiedBy: operator._id,
      verifiedAt: nowMinus(1),
      createdAt: nowMinus(10),
      updatedAt: nowMinus(1),
    },
    {
      offeringId: offeringB._id,
      name: "Framing",
      percent: 20,
      status: "in_review",
      evidenceDocs: [{ docId: "m2", filename: "framing-progress.pdf" }],
      createdAt: nowMinus(8),
      updatedAt: nowMinus(3),
    },
    {
      offeringId: offeringB._id,
      name: "Roofing",
      percent: 20,
      status: "not_started",
      evidenceDocs: [],
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      name: "Finishing",
      percent: 25,
      status: "not_started",
      evidenceDocs: [],
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      name: "Handover",
      percent: 15,
      status: "not_started",
      evidenceDocs: [],
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
  ]);

  await TrancheModel.create([
    {
      offeringId: offeringB._id,
      milestoneId: milestoneDocs[0]._id,
      amount: toDecimal(24000000),
      status: "eligible",
      createdAt: nowMinus(8),
      updatedAt: nowMinus(1),
    },
    {
      offeringId: offeringB._id,
      milestoneId: milestoneDocs[1]._id,
      amount: toDecimal(24000000),
      status: "locked",
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      milestoneId: milestoneDocs[2]._id,
      amount: toDecimal(24000000),
      status: "locked",
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      milestoneId: milestoneDocs[3]._id,
      amount: toDecimal(30000000),
      status: "locked",
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
    {
      offeringId: offeringB._id,
      milestoneId: milestoneDocs[4]._id,
      amount: toDecimal(18000000),
      status: "locked",
      createdAt: nowMinus(8),
      updatedAt: nowMinus(8),
    },
  ]);

  // ── Disputes ──────────────────────────────────────────────────────────────────
  await DisputeModel.create([
    {
      entityType: "subscription",
      entityId: String(subscriptions[1]._id),
      reason: "Payment reversal request by investor",
      details: "Investor requested cancellation after transfer delay of 7 business days.",
      status: "open",
      raisedBy: inv2._id,
      createdAt: nowMinus(4),
      updatedAt: nowMinus(4),
    },
    {
      entityType: "distribution",
      entityId: String(distributionA1._id),
      reason: "Distribution reconciliation mismatch",
      details: "Operator flagged mismatch during payout verification — ₦42,000 unaccounted.",
      status: "investigating",
      raisedBy: operator._id,
      assignedTo: operator2._id,
      createdAt: nowMinus(2),
      updatedAt: nowMinus(1),
    },
  ]);

  // ── Notifications ──────────────────────────────────────────────────────────────
  await NotificationModel.create([
    {
      recipientUserId: issuerOne._id,
      recipientEmail: "issuer1@fractal.demo",
      recipientName: "Bluebrick Issuer",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "application",
      entityId: String(applicationA._id),
      action: "ApplicationApproved",
      title: "Application approved",
      message: "Your application for Lekki Apartment Block has been approved and an offering has been created.",
      createdAt: nowMinus(30),
      updatedAt: nowMinus(30),
    },
    {
      recipientUserId: inv1._id,
      recipientEmail: "investor1@fractal.demo",
      recipientName: "Amara Osei",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "subscription",
      entityId: String(subscriptions[0]._id),
      action: "SubscriptionPaid",
      title: "Subscription confirmed",
      message: "Your subscription of ₦5,000,000 to Lekki Rental Yield Note Series A has been marked as paid.",
      createdAt: nowMinus(12),
      updatedAt: nowMinus(12),
    },
    {
      recipientUserId: inv2._id,
      recipientEmail: "investor2@fractal.demo",
      recipientName: "Kwame Mensah",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "subscription",
      entityId: String(subscriptions[1]._id),
      action: "DisputeOpened",
      title: "Dispute opened on your subscription",
      message: "A payment reversal dispute has been opened for your ₦2,000,000 subscription.",
      createdAt: nowMinus(4),
      updatedAt: nowMinus(4),
    },
    {
      recipientUserId: issuerTwo._id,
      recipientEmail: "issuer2@fractal.demo",
      recipientName: "Northfield Issuer",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "milestone",
      entityId: String(milestoneDocs[0]._id),
      action: "MilestoneVerified",
      title: "Milestone verified — Foundation",
      message: "The Foundation milestone for Abuja Developer Inventory Note I has been verified. Tranche is eligible.",
      createdAt: nowMinus(1),
      updatedAt: nowMinus(1),
    },
    {
      recipientUserId: operator._id,
      recipientEmail: "operator@fractal.demo",
      recipientName: "Review Operator",
      actorUserId: issuerOne._id,
      actorRoleAtTime: "issuer",
      entityType: "application",
      entityId: String(applicationC._id),
      action: "ApplicationSubmitted",
      title: "New application submitted for review",
      message: "Bluebrick Issuer submitted a new application (VI Commercial Plaza) for diligence review.",
      createdAt: nowMinus(5),
      updatedAt: nowMinus(5),
    },
    {
      recipientUserId: inspectorUser._id,
      recipientEmail: "inspector1@fractal.demo",
      recipientName: "Ade Inspection Ltd",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "task",
      entityId: "seed-task-app-c",
      action: "WorkOrderAssigned",
      title: "New work order assigned",
      message: "You have been assigned a valuation task for VI Commercial Plaza. SLA: 5 days.",
      createdAt: nowMinus(3),
      updatedAt: nowMinus(3),
    },
    {
      recipientUserId: inv5._id,
      recipientEmail: "investor5@fractal.demo",
      recipientName: "Chidinma Eze",
      actorUserId: operator._id,
      actorRoleAtTime: "operator",
      entityType: "distribution",
      entityId: String(distributionA2._id),
      action: "DistributionScheduled",
      title: "Upcoming distribution scheduled",
      message: "A distribution of ₦1,200,000 for Lekki Rental Yield Note Series A has been scheduled for March 2026.",
      createdAt: nowMinus(2),
      updatedAt: nowMinus(2),
    },
  ]);

  // ── Event Log ─────────────────────────────────────────────────────────────────
  await EventLogModel.create([
    {
      entityType: "application",
      entityId: String(applicationA._id),
      action: "Application approved",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(30),
    },
    {
      entityType: "application",
      entityId: String(applicationB._id),
      action: "Application approved",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(28),
    },
    {
      entityType: "application",
      entityId: String(applicationC._id),
      action: "Application submitted for review",
      actorUserId: issuerOne._id,
      roleAtTime: "issuer",
      timestamp: nowMinus(5),
    },
    {
      entityType: "offering",
      entityId: String(offeringA._id),
      action: "Offering approved and opened",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(19),
    },
    {
      entityType: "offering",
      entityId: String(offeringB._id),
      action: "Offering approved and opened",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(14),
    },
    {
      entityType: "subscription",
      entityId: String(subscriptions[0]._id),
      action: "Subscription marked paid",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(12),
    },
    {
      entityType: "distribution",
      entityId: String(distributionA2._id),
      action: "Distribution scheduled",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(1),
    },
    {
      entityType: "milestone",
      entityId: String(milestoneDocs[0]._id),
      action: "Milestone verified",
      actorUserId: operator._id,
      roleAtTime: "operator",
      timestamp: nowMinus(1),
    },
  ]);

  console.log("✅ Seed completed successfully.");
  console.log("");
  console.log("Demo accounts (password: Demo1234!):");
  console.log("  admin@fractal.demo         — admin");
  console.log("  operator@fractal.demo      — operator");
  console.log("  operator2@fractal.demo     — operator (second)");
  console.log("  issuer1@fractal.demo       — issuer (Bluebrick Estates)");
  console.log("  issuer2@fractal.demo       — issuer (Northfield Developments)");
  console.log("  investor1@fractal.demo     — investor (KYC approved, sophisticated)");
  console.log("  investor2@fractal.demo     — investor (KYC approved, retail)");
  console.log("  investor3@fractal.demo     — investor (KYC in_review)");
  console.log("  investor4@fractal.demo     — investor (KYC draft)");
  console.log("  investor5@fractal.demo     — investor (KYC approved, subscribed both)");
  console.log("  investor6@fractal.demo     — investor (KYC rejected)");
  console.log("  inspector1@fractal.demo    — professional (inspector)");
  console.log("  valuer1@fractal.demo       — professional (valuer)");
  console.log("  lawyer1@fractal.demo       — professional (lawyer)");
}

seed()
  .then(async () => {
    await disconnectMongo();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await disconnectMongo();
    process.exit(1);
  });
