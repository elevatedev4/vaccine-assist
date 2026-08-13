using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using VaccineAssist.Desktop.Models;

namespace VaccineAssist.Desktop.Services;

/// <summary>See IVaccineApiService. HttpClient.BaseAddress is expected to
/// already be set to AppSettings.CloudApiBaseUrl by the composition root
/// (App.xaml.cs) — this class only knows relative paths.</summary>
public sealed class VaccineApiService : IVaccineApiService
{
    private readonly HttpClient _httpClient;
    private readonly IAuthService _authService;

    public VaccineApiService(HttpClient httpClient, IAuthService authService)
    {
        _httpClient = httpClient;
        _authService = authService;
    }

    public async Task<IReadOnlyList<Vaccine>> GetVaccinesAsync(CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(HttpMethod.Get, "/api/vaccines");
        var result = await SendAsync<VaccinesResponse>(request, cancellationToken);
        return result.Vaccines;
    }

    public async Task<IReadOnlyList<Lot>> GetLotsAsync(
        Guid? vaccineId = null,
        string? status = null,
        CancellationToken cancellationToken = default)
    {
        var query = new List<string>();
        if (vaccineId is Guid id) query.Add($"vaccineId={id}");
        if (!string.IsNullOrWhiteSpace(status)) query.Add($"status={Uri.EscapeDataString(status)}");
        var path = query.Count > 0 ? $"/api/lots?{string.Join("&", query)}" : "/api/lots";

        using var request = CreateRequest(HttpMethod.Get, path);
        var result = await SendAsync<LotsResponse>(request, cancellationToken);
        return result.Lots;
    }

    public async Task<Lot> CreateLotAsync(
        Guid vaccineId,
        string lotNumber,
        DateOnly expiration,
        string status = "active",
        string? note = null,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(HttpMethod.Post, "/api/lots");
        request.Content = JsonContent.Create(new CreateLotRequest(vaccineId, lotNumber, expiration, status, note));

        var result = await SendAsync<LotResponse>(request, cancellationToken);
        return result.Lot;
    }

    public async Task<EligibilityResult> EvaluateEligibilityAsync(
        Guid vaccineId,
        int ageYears,
        bool? isPregnant = null,
        CancellationToken cancellationToken = default)
    {
        using var request = CreateRequest(HttpMethod.Post, "/api/eligibility/evaluate");
        request.Content = JsonContent.Create(new EvaluateEligibilityRequest(vaccineId, ageYears, isPregnant));

        return await SendAsync<EligibilityResult>(request, cancellationToken);
    }

    private HttpRequestMessage CreateRequest(HttpMethod method, string relativePath)
    {
        var request = new HttpRequestMessage(method, relativePath);
        if (_authService.AccessToken is string token)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        return request;
    }

    private async Task<T> SendAsync<T>(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        using var response = await _httpClient.SendAsync(request, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            string message = $"Request to {request.RequestUri} failed with {(int)response.StatusCode}.";
            try
            {
                var error = await response.Content.ReadFromJsonAsync<ErrorResponse>(cancellationToken: cancellationToken);
                if (!string.IsNullOrWhiteSpace(error?.Error))
                {
                    message = error!.Error;
                }
            }
            catch
            {
                // Response body wasn't the expected {error} shape — keep the generic message.
            }

            throw new VaccineApiException(response.StatusCode, message);
        }

        var result = await response.Content.ReadFromJsonAsync<T>(cancellationToken: cancellationToken);
        if (result is null)
        {
            throw new VaccineApiException(response.StatusCode, $"Empty response body from {request.RequestUri}.");
        }
        return result;
    }

    private sealed class VaccinesResponse
    {
        [JsonPropertyName("vaccines")]
        public List<Vaccine> Vaccines { get; set; } = new();
    }

    private sealed class LotsResponse
    {
        [JsonPropertyName("lots")]
        public List<Lot> Lots { get; set; } = new();
    }

    private sealed class LotResponse
    {
        [JsonPropertyName("lot")]
        public Lot Lot { get; set; } = new();
    }

    private sealed class ErrorResponse
    {
        [JsonPropertyName("error")]
        public string? Error { get; set; }
    }

    private sealed record CreateLotRequest(
        [property: JsonPropertyName("vaccine_id")] Guid VaccineId,
        [property: JsonPropertyName("lot_number")] string LotNumber,
        [property: JsonPropertyName("expiration")] DateOnly Expiration,
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("note")] string? Note);

    private sealed record EvaluateEligibilityRequest(
        [property: JsonPropertyName("vaccineId")] Guid VaccineId,
        [property: JsonPropertyName("ageYears")] int AgeYears,
        [property: JsonPropertyName("isPregnant")] bool? IsPregnant);
}
