using System;
using System.Net;

namespace VaccineAssist.Desktop.Services;

/// <summary>Thrown by VaccineApiService when the cloud API returns a non-success status.</summary>
public sealed class VaccineApiException : Exception
{
    public HttpStatusCode StatusCode { get; }

    public VaccineApiException(HttpStatusCode statusCode, string message) : base(message)
    {
        StatusCode = statusCode;
    }
}
